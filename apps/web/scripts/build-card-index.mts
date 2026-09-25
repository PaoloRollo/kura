/**
 * Build the card-image embedding index from Scryfall's unique_artwork bulk file (--all), or, for
 * --sets, from every artwork printed in those sets (search API, so reprinted art is not missed).
 *
 *   OMP_NUM_THREADS=2 nice -n 19 pnpm --filter web build:index -- --sets lea,leb,2ed   # scoped (dev, tests)
 *   pnpm --filter web build:index -- --all                   # everything (~50k artworks)
 *   options: --limit N, --out DIR (default data/card-index), --image small|normal, --concurrency 8
 *
 * The bulk file is stream-parsed; images are downloaded into memory, embedded and dropped (never
 * written to disk). Each embedded row is appended to DIR/progress.jsonl, so an interrupted build
 * resumes, and a re-run reuses every illustration already in DIR with the same recipe.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CARD_EMBED_SPEC } from "../src/lib/embed-spec";
import { createNodeEmbedder, decodeImage } from "./lib/node-embedder";
import { appendProgress, readEmbedded, writeIndex, type Embedded } from "./lib/index-store";
import { discoverBulk, indexRows, setArtworks, streamBulk, type BulkCard, type IndexRow } from "./lib/scryfall-bulk";
import { fetchImage, mapPool } from "./lib/scryfall-http";

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    sets: { type: "string" },
    all: { type: "boolean", default: false },
    limit: { type: "string" },
    out: { type: "string", default: "data/card-index" },
    image: { type: "string", default: "normal" },
    concurrency: { type: "string", default: "8" },
  },
});
if (!args.all && !args.sets) {
  console.error("pass --sets a,b,c or --all");
  process.exit(2);
}
if (args.image !== "small" && args.image !== "normal") throw new Error("--image must be small or normal");
const image: "small" | "normal" = args.image;
const sets = args.all ? null : new Set(args.sets!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const limit = args.limit ? Number(args.limit) : null;
const out = resolve(process.cwd(), args.out!);
const spec = CARD_EMBED_SPEC;
const started = Date.now();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

log(`scope: ${sets ? [...sets].join(",") : "all"}${limit ? ` (limit ${limit})` : ""}; model ${spec.model} ${spec.dtype}; image ${image}; out ${out}`);
// Scoped builds read the search API as of now; full builds name the bulk file's own timestamp.
const source = sets
  ? { bulk: "search: set:<code> unique:art", updatedAt: new Date().toISOString() }
  : { bulk: "unique_artwork", updatedAt: (await discoverBulk("unique_artwork")).updatedAt };
const scope: IndexRow[] = [];
const seen = new Set<string>();
const add = (card: BulkCard) => {
  for (const row of indexRows(card, image)) {
    if (seen.has(row.illustration_id)) continue;
    seen.add(row.illustration_id);
    scope.push(row);
  }
};
if (sets) {
  // Scoped: every artwork printed in those sets (the search API), not just unique_artwork's representatives.
  outer: for (const set of sets) {
    for await (const card of setArtworks(set)) {
      add(card);
      if (limit && scope.length >= limit) break outer;
    }
  }
} else {
  for await (const card of streamBulk("unique_artwork")) {
    add(card);
    if (limit && scope.length >= limit) break;
  }
}
if (limit) scope.length = Math.min(scope.length, limit);
log(`${scope.length} artworks in scope`);

const done = readEmbedded(out, spec);
const todo = scope.filter((r) => !done.has(r.illustration_id));
log(`${scope.length - todo.length} already embedded, ${todo.length} to go`);

const embedder = await createNodeEmbedder(spec);
let chain: Promise<unknown> = Promise.resolve();
/** onnxruntime runs one inference at a time here; downloads overlap with it. */
const embedSerial = (buf: Buffer) => {
  const run = async () => embedder.embed(await decodeImage(buf), spec);
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
};

let n = 0;
const failures: string[] = [];
await mapPool(todo, Number(args.concurrency), async (row) => {
  try {
    const vector = await embedSerial(await fetchImage(row.image));
    appendProgress(out, spec, row, vector);
    done.set(row.illustration_id, { row, vector });
  } catch (e) {
    failures.push(`${row.name} (${row.set} ${row.collector_number}): ${String(e)}`);
  }
  if (++n % 100 === 0 || n === todo.length) {
    const rate = n / ((Date.now() - started) / 1000);
    log(`${n}/${todo.length} (${rate.toFixed(1)}/s, eta ${Math.round((todo.length - n) / rate)} s, ${failures.length} failed)`);
  }
});

const rows: Embedded[] = scope.flatMap((r) => (done.has(r.illustration_id) ? [done.get(r.illustration_id)!] : []));
const manifest = writeIndex(out, rows, spec, {
  image,
  scope: { sets: sets ? [...sets] : "all", limit },
  source,
  buildSeconds: Math.round((Date.now() - started) / 1000),
});
log(`wrote ${manifest.count} rows (${manifest.dims} dims) to ${out} in ${manifest.buildSeconds} s`);
if (failures.length) {
  log(`${failures.length} failed (re-run to retry):`);
  for (const f of failures.slice(0, 20)) log(`  ${f}`);
}
