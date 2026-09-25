/**
 * Measure candidate image-embedding models for card recognition.
 *
 * 60 query cards across eras (lea/leb/2ed, 2015, 2020+, borderless/full-art, foil-treatment promos,
 * and a spread of other years) are each turned into 5 synthetic webcam photos and searched against an
 * int8 index of those cards' artworks plus 2,000 random distractor artworks from Scryfall's
 * unique_artwork file. Accuracy is at the artwork level (illustration_id). Images live only in memory.
 *
 * It also reports an open-set score: each photo's best score once its own artwork is removed from the
 * index (what the station sees for a card outside the index), to pick the low-confidence threshold.
 *
 *   OMP_NUM_THREADS=2 nice -n 19 pnpm --filter web exec tsx scripts/eval-embeddings.mts \
 *     [--distractors 2000] [--photos 5] [--models dinov2-small,clip-vit-b32] [--crops full,top55] \
 *     [--cache DIR] [--no-small] [--out results.json]
 *
 * --cache keeps the pooled index vectors (not images) per model/crop/pooling, so a re-run skips
 * downloading and embedding the distractors again.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decodeVectors, encodeVectors, topK } from "../src/lib/card-vectors";
import { ART_TOP, CLIP_MEAN, CLIP_STD, FULL_CARD, IMAGENET_MEAN, IMAGENET_STD, pool, type Crop, type EmbedSpec, type Pixels } from "../src/lib/embed-spec";
import { createNodeEmbedder, decodeImage } from "./lib/node-embedder";
import { prng, simulatePhoto } from "./lib/photo-sim";
import { indexRows, streamBulk, type BulkCard, type IndexRow } from "./lib/scryfall-bulk";
import { fetchImage, mapPool, scryfallApi } from "./lib/scryfall-http";
import { wasmForwardMs } from "./lib/wasm-bench";

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    distractors: { type: "string", default: "2000" },
    photos: { type: "string", default: "5" },
    models: { type: "string" },
    crops: { type: "string" },
    cache: { type: "string" },
    "no-small": { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const DISTRACTORS = Number(args.distractors);
const PHOTOS = Number(args.photos);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

type Model = Pick<EmbedSpec, "model" | "arch" | "dtype" | "size" | "mean" | "std"> & { label: string; poolings: EmbedSpec["pooling"][]; dims: number };
const MODELS: Model[] = [
  { label: "dinov2-small", model: "Xenova/dinov2-small", arch: "dinov2", dtype: "q8", size: 224, mean: IMAGENET_MEAN, std: IMAGENET_STD, poolings: ["cls", "mean", "cls+mean"], dims: 384 },
  { label: "clip-vit-b32", model: "Xenova/clip-vit-base-patch32", arch: "clip", dtype: "q8", size: 224, mean: CLIP_MEAN, std: CLIP_STD, poolings: ["embeds"], dims: 512 },
];
const ALL_CROPS: { label: string; crop: Crop }[] = [
  { label: "full", crop: FULL_CARD },
  { label: "top55", crop: ART_TOP },
];
const pick = <T extends { label: string }>(all: T[], flag: string | undefined) => {
  if (!flag) return all;
  const want = flag.split(",");
  const out = all.filter((x) => want.includes(x.label));
  if (out.length !== want.length) throw new Error(`unknown value in ${flag}; known: ${all.map((x) => x.label).join(",")}`);
  return out;
};
const models = pick(MODELS, args.models);
const CROPS = pick(ALL_CROPS, args.crops);

// ---------------------------------------------------------------------------------------------
// 1. Pick the eval set from unique_artwork (plus cross-printing leb/2ed queries from the search API).

type Query = { category: string; illustration: string; image: string; label: string };

log("streaming unique_artwork");
const reps = new Map<string, IndexRow>();
const pools: Record<string, IndexRow[]> = { lea: [], y2015: [], y2020: [], borderless: [], other: [] };
for await (const card of streamBulk("unique_artwork")) {
  const rows = indexRows(card as BulkCard, "normal");
  if (rows.length === 0) continue;
  const row = rows[0];
  if (reps.has(row.illustration_id)) continue;
  reps.set(row.illustration_id, row);
  if (row.lang !== "en") continue;
  const year = Number((card.released_at ?? "0").slice(0, 4));
  if (card.set === "lea") pools.lea.push(row);
  else if (card.border_color === "borderless" || card.full_art) pools.borderless.push(row);
  else if (year === 2015) pools.y2015.push(row);
  else if (year >= 2020) pools.y2020.push(row);
  else if (year >= 1994 && year <= 2014) pools.other.push(row);
}
log(`indexable artworks: ${reps.size}`, Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])));

const rand = prng(20260925);
function sample<T>(xs: T[], n: number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

const queries: Query[] = [];
const fromPool = (category: string, n: number) => {
  for (const r of sample(pools[category], n)) queries.push({ category, illustration: r.illustration_id, image: r.image, label: `${r.name} (${r.set})` });
};
fromPool("lea", 6);
// leb and 2ed share Alpha's art, so their unique_artwork representative is usually another printing:
// these queries photograph one printing and must find the artwork scanned from a different one.
for (const [set, n] of [["leb", 4], ["2ed", 4]] as const) {
  const page = await scryfallApi<{ data: BulkCard[] }>(`/cards/search?q=${encodeURIComponent(`set:${set}`)}&unique=prints&order=set`);
  const picks = sample(page.data.flatMap((c) => indexRows(c, "normal")).filter((r) => reps.has(r.illustration_id) && reps.get(r.illustration_id)!.scryfall_id !== r.scryfall_id), n);
  for (const r of picks) queries.push({ category: set, illustration: r.illustration_id, image: r.image, label: `${r.name} (${r.set}, index has ${reps.get(r.illustration_id)!.set})` });
}
// unique_artwork's representative of an artwork is rarely the foil promo printing, so photograph the
// promo itself (from the search API) and require the artwork the index holds for it.
{
  const page = await scryfallApi<{ data: BulkCard[] }>(`/cards/search?q=${encodeURIComponent("is:promo is:foil -is:digital lang:en")}&unique=prints&order=released&dir=desc`);
  const picks = sample(page.data.flatMap((c) => indexRows(c, "normal")).filter((r) => reps.has(r.illustration_id)), 6);
  for (const r of picks) queries.push({ category: "foilpromo", illustration: r.illustration_id, image: r.image, label: `${r.name} (${r.set} promo, index has ${reps.get(r.illustration_id)!.set})` });
}
fromPool("y2015", 8);
fromPool("y2020", 10);
fromPool("borderless", 8);
fromPool("other", 60 - queries.length);

const queryIllustrations = new Set(queries.map((q) => q.illustration));
const indexRowsForEval: IndexRow[] = [
  ...[...queryIllustrations].map((i) => reps.get(i)!),
  ...sample([...reps.values()].filter((r) => !queryIllustrations.has(r.illustration_id)), DISTRACTORS),
];
log(`queries: ${queries.length}, index rows: ${indexRowsForEval.length}`);

// ---------------------------------------------------------------------------------------------
// 2. Pooled-vector cache, downloads (into memory only) and the synthetic photos.

type Pooling = EmbedSpec["pooling"];
const cacheKey = (model: Model, crop: string, pooling: Pooling, image: string) => `${model.model}|${crop}|${pooling}|${image}`;
const cache = new Map<string, Float32Array>();
const cacheFile = args.cache ? join(args.cache, "eval-vectors.jsonl") : null;
if (cacheFile && existsSync(cacheFile)) {
  for (const line of readFileSync(cacheFile, "utf8").split("\n")) {
    if (!line) continue;
    const { k, v } = JSON.parse(line) as { k: string; v: string };
    const b = Buffer.from(v, "base64");
    cache.set(k, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
  }
  log(`cache: ${cache.size} pooled vectors from ${cacheFile}`);
}
function cachePut(k: string, v: Float32Array) {
  cache.set(k, v);
  if (!cacheFile) return;
  mkdirSync(args.cache!, { recursive: true });
  appendFileSync(cacheFile, JSON.stringify({ k, v: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") }) + "\n");
}
const configs = models.flatMap((m) => CROPS.flatMap((c) => m.poolings.map((p) => ({ m, c: c.label, p }))));
const needsEmbedding = (image: string) => configs.some(({ m, c, p }) => !cache.has(cacheKey(m, c, p, image)));

const images = new Map<string, Buffer>();
const failed = new Set<string>();
async function download(urls: string[], what: string) {
  let n = 0;
  await mapPool(urls, 8, async (u) => {
    try {
      images.set(u, await fetchImage(u));
    } catch (e) {
      failed.add(u);
      log("download failed", u, String(e));
    }
    if (++n % 250 === 0) log(`downloaded ${what} ${n}/${urls.length}`);
  });
}
await download([...new Set([...queries.map((q) => q.image), ...indexRowsForEval.map((r) => r.image).filter(needsEmbedding)])], "normal");
const indexSet = indexRowsForEval.filter((r) => !failed.has(r.image));
const querySet = queries.filter((q) => images.has(q.image));

log("synthesising photos");
const photos: { q: Query; pixels: Pixels }[] = [];
for (const [qi, q] of querySet.entries()) {
  for (let k = 0; k < PHOTOS; k++) photos.push({ q, pixels: await decodeImage(await simulatePhoto(images.get(q.image)!, 1000 * qi + k)) });
}

// ---------------------------------------------------------------------------------------------
// 3. Embed with each model and crop; evaluate each pooling on the int8 index.

type Margin = { correct: boolean; top1: number; margin: number; openSet: number; openMargin: number };
type Result = { config: string; model: string; crop: string; pooling: string; dims: number; top1: number; top5: number; msPerEmbed: number; byCategory: Record<string, number>; margins: Margin[] };
const results: Result[] = [];

function evaluate(label: string, model: Model, crop: string, pooling: Pooling, indexVecs: Float32Array[], queryVecs: Float32Array[], ms: number, rows: IndexRow[]): Result {
  const dims = indexVecs[0].length;
  const index = decodeVectors(encodeVectors(indexVecs, dims), dims);
  let top1 = 0, top5 = 0;
  const cat: Record<string, [number, number]> = {};
  const margins: Margin[] = [];
  queryVecs.forEach((v, i) => {
    const { q } = photos[i];
    const hits = topK(index, v, 6);
    const own = (h: { row: number }) => rows[h.row].illustration_id === q.illustration;
    const ok1 = own(hits[0]);
    top1 += ok1 ? 1 : 0;
    top5 += hits.slice(0, 5).some(own) ? 1 : 0;
    (cat[q.category] ??= [0, 0])[0] += ok1 ? 1 : 0;
    cat[q.category][1]++;
    // Open set: the best score among rows that are not this card's artwork.
    const others = hits.filter((h) => !own(h));
    margins.push({ correct: ok1, top1: hits[0].score, margin: hits[0].score - hits[1].score, openSet: others[0].score, openMargin: others[0].score - others[1].score });
  });
  const n = queryVecs.length;
  return { config: label, model: model.label, crop, pooling, dims, top1: top1 / n, top5: top5 / n, msPerEmbed: ms, byCategory: Object.fromEntries(Object.entries(cat).map(([k, [a, b]]) => [k, a / b])), margins };
}

async function embedAll(model: Model, embedder: Awaited<ReturnType<typeof createNodeEmbedder>>, cropLabel: string, rows: IndexRow[]) {
  const crop = ALL_CROPS.find((c) => c.label === cropLabel)!.crop;
  const indexVecs = new Map<Pooling, Float32Array[]>(model.poolings.map((p) => [p, []]));
  let embedded = 0;
  for (const r of rows) {
    const keys = model.poolings.map((p) => cacheKey(model, cropLabel, p, r.image));
    if (!keys.every((k) => cache.has(k))) {
      const out = await embedder.forward(await decodeImage(images.get(r.image)!), crop);
      model.poolings.forEach((p, i) => cachePut(keys[i], pool({ pooling: p }, out)));
      if (++embedded % 500 === 0) log(`  index ${embedded} embedded`);
    }
    model.poolings.forEach((p, i) => indexVecs.get(p)!.push(cache.get(keys[i])!));
  }
  const queryVecs = new Map<Pooling, Float32Array[]>(model.poolings.map((p) => [p, []]));
  const t0 = performance.now();
  for (const ph of photos) {
    const out = await embedder.forward(ph.pixels, crop);
    for (const p of model.poolings) queryVecs.get(p)!.push(pool({ pooling: p }, out));
  }
  return { indexVecs, queryVecs, ms: (performance.now() - t0) / photos.length };
}

for (const model of models) {
  log(`loading ${model.model} (${model.dtype})`);
  const embedder = await createNodeEmbedder(model);
  for (const { label: cropLabel } of CROPS) {
    log(`embedding ${model.label} / ${cropLabel}`);
    const { indexVecs, queryVecs, ms } = await embedAll(model, embedder, cropLabel, indexSet);
    for (const pooling of model.poolings) {
      const r = evaluate(`${model.label}/${cropLabel}/${pooling}`, model, cropLabel, pooling, indexVecs.get(pooling)!, queryVecs.get(pooling)!, ms, indexSet);
      results.push(r);
      log(`${r.config}: top1 ${(100 * r.top1).toFixed(1)}% top5 ${(100 * r.top5).toFixed(1)}% (${ms.toFixed(0)} ms/embed)`);
    }
  }
}

// Browser-fallback speed: onnxruntime-web WASM, one thread, on the same quantized weights.
const wasm = new Map<string, Awaited<ReturnType<typeof wasmForwardMs>>>();
for (const model of models) {
  wasm.set(model.label, await wasmForwardMs(model.model, model.size));
  log(`${model.label}: wasm 1-thread ${wasm.get(model.label)!.medianMs.toFixed(0)} ms/forward, ${wasm.get(model.label)!.mb.toFixed(1)} MB`);
}

// ---------------------------------------------------------------------------------------------
// 4. For the best config, also try an index built from Scryfall's `small` images (5x less to download).

const best = results.slice().sort((a, b) => b.top1 - a.top1 || b.top5 - a.top5 || a.dims - b.dims)[0];
log(`best: ${best.config}`);
if (!args["no-small"]) {
  const bestModel = models.find((m) => m.label === best.model)!;
  const pooling = best.pooling as Pooling;
  const smallRows = indexSet.map((r) => ({ ...r, image: r.image.replace("/normal/", "/small/") }));
  await download(smallRows.map((r) => r.image).filter((u) => !cache.has(cacheKey(bestModel, best.crop, pooling, u))), "small");
  if (smallRows.every((r) => !failed.has(r.image))) {
    const small = { ...bestModel, poolings: [pooling] };
    const embedder = await createNodeEmbedder(small);
    const { indexVecs, queryVecs, ms } = await embedAll(small, embedder, best.crop, smallRows);
    const r = evaluate(`${best.config} (small index)`, small, best.crop, pooling, indexVecs.get(pooling)!, queryVecs.get(pooling)!, ms, smallRows);
    results.push(r);
    log(`${r.config}: top1 ${(100 * r.top1).toFixed(1)}% top5 ${(100 * r.top5).toFixed(1)}%`);
  }
}

// ---------------------------------------------------------------------------------------------
// 5. Report.

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const quantile = (xs: number[], p: number) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN);
const cats = [...new Set(querySet.map((q) => q.category))];
console.log(`\nqueries: ${querySet.length} cards x ${PHOTOS} photos = ${photos.length}; index: ${indexSet.length} artworks (${new Set(querySet.map((q) => q.illustration)).size} targets + ${indexSet.length - new Set(querySet.map((q) => q.illustration)).size} distractors); failed downloads: ${failed.size}\n`);
console.log(`| config | dims | top-1 | top-5 | correct top-1 score p5 | open-set score p95 | ms/embed (node, 2 threads) | ${cats.join(" | ")} |`);
console.log(`|---|---|---|---|---|---|---|${cats.map(() => "---").join("|")}|`);
for (const r of results) {
  const correct = r.margins.filter((m) => m.correct).map((m) => m.top1);
  console.log(`| ${r.config} | ${r.dims} | ${pct(r.top1)} | ${pct(r.top5)} | ${quantile(correct, 0.05).toFixed(3)} | ${quantile(r.margins.map((m) => m.openSet), 0.95).toFixed(3)} | ${r.msPerEmbed.toFixed(0)} | ${cats.map((c) => pct(r.byCategory[c] ?? 0)).join(" | ")} |`);
}

console.log("\n| model | weights | download | wasm 1-thread ms/forward (node, onnxruntime-web) |");
console.log("|---|---|---|---|");
for (const [label, w] of wasm) console.log(`| ${label} | ${w.file} | ${w.mb.toFixed(1)} MB | ${w.medianMs.toFixed(0)} |`);

console.log(`\nthresholds for ${best.config} (top-1 cosine). accept = top-1 at or above the threshold;`);
console.log("open-set accept = a card whose artwork is NOT in the index would still be preselected.");
console.log("| threshold | in-index accepted | precision of accepted | open-set accepted |");
console.log("|---|---|---|---|");
for (let t = 0.5; t <= 0.951; t += 0.025) {
  const above = best.margins.filter((m) => m.top1 >= t);
  const ok = above.filter((m) => m.correct).length;
  const open = best.margins.filter((m) => m.openSet >= t).length;
  console.log(`| ${t.toFixed(3)} | ${pct(above.length / best.margins.length)} | ${above.length ? pct(ok / above.length) : "-"} | ${pct(open / best.margins.length)} |`);
}
console.log(`\nmargin rule for ${best.config}: accept when top-1 minus top-2 (different artworks) is at least m.`);
console.log("| margin m | in-index accepted | precision of accepted | open-set accepted |");
console.log("|---|---|---|---|");
for (const m of [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15]) {
  const above = best.margins.filter((x) => x.margin >= m);
  const ok = above.filter((x) => x.correct).length;
  const open = best.margins.filter((x) => x.openMargin >= m).length;
  console.log(`| ${m.toFixed(2)} | ${pct(above.length / best.margins.length)} | ${above.length ? pct(ok / above.length) : "-"} | ${pct(open / best.margins.length)} |`);
}
console.log(`\ncombined rule for ${best.config}: accept when top-1 >= t AND margin >= m.`);
console.log("| t | m | in-index accepted | precision of accepted | open-set accepted |");
console.log("|---|---|---|---|---|");
for (const t of [0.75, 0.775, 0.8, 0.825]) {
  for (const m of [0.02, 0.03, 0.04]) {
    const above = best.margins.filter((x) => x.top1 >= t && x.margin >= m);
    const ok = above.filter((x) => x.correct).length;
    const open = best.margins.filter((x) => x.openSet >= t && x.openMargin >= m).length;
    console.log(`| ${t.toFixed(3)} | ${m.toFixed(2)} | ${pct(above.length / best.margins.length)} | ${above.length ? pct(ok / above.length) : "-"} | ${pct(open / best.margins.length)} |`);
  }
}
console.log(`in-index margin: p5 ${quantile(best.margins.filter((m) => m.correct).map((m) => m.margin), 0.05).toFixed(3)} p50 ${quantile(best.margins.map((m) => m.margin), 0.5).toFixed(3)}; open-set margin: p50 ${quantile(best.margins.map((m) => m.openMargin), 0.5).toFixed(3)} p95 ${quantile(best.margins.map((m) => m.openMargin), 0.95).toFixed(3)} max ${Math.max(...best.margins.map((m) => m.openMargin)).toFixed(3)}`);
for (const r of results) {
  const inM = r.margins.filter((m) => m.correct).map((m) => m.margin);
  console.log(`  ${r.config}: in-index margin p5 ${quantile(inM, 0.05).toFixed(3)}, open-set margin p95 ${quantile(r.margins.map((m) => m.openMargin), 0.95).toFixed(3)}`);
}

const correct = best.margins.filter((m) => m.correct).map((m) => m.top1);
const wrong = best.margins.filter((m) => !m.correct).map((m) => m.top1);
const open = best.margins.map((m) => m.openSet);
console.log(`\ncorrect top-1: p5 ${quantile(correct, 0.05).toFixed(3)} p50 ${quantile(correct, 0.5).toFixed(3)}; wrong top-1: n=${wrong.length} p50 ${quantile(wrong, 0.5).toFixed(3)}; open-set top-1: p50 ${quantile(open, 0.5).toFixed(3)} p95 ${quantile(open, 0.95).toFixed(3)} max ${Math.max(...open).toFixed(3)}`);
const misses = photos.map((p, i) => ({ p, m: best.margins[i] })).filter((x) => !x.m.correct);
console.log(`misses (${misses.length}):`, [...new Set(misses.map((x) => x.p.q.label))].join("; "));

if (args.out) writeFileSync(args.out, JSON.stringify({ queries: querySet, results: results.map((r) => ({ ...r, margins: undefined })) }, null, 2));
