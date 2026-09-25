import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manifestFor, manifestMatchesSpec, type CardIndexManifest, type CardIndexRow } from "../../src/lib/card-index-format";
import { decodeVectors, dequantize, encodeVectors, quantize } from "../../src/lib/card-vectors";
import type { EmbedSpec } from "../../src/lib/embed-spec";

export type Embedded = { row: CardIndexRow; vector: Float32Array };
type ProgressLine = { recipe: string; row: CardIndexRow; q: string; scale: number };

const PROGRESS = "progress.jsonl";
const recipeKey = (spec: EmbedSpec) => JSON.stringify(manifestFor(spec));

/** Everything already embedded with this recipe: the finished index plus the progress file of an interrupted run. */
export function readEmbedded(dir: string, spec: EmbedSpec): Map<string, Embedded> {
  const done = new Map<string, Embedded>();
  const manifestPath = join(dir, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CardIndexManifest;
    if (manifestMatchesSpec(manifest, spec)) {
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as CardIndexRow[];
      const index = decodeVectors(new Uint8Array(readFileSync(join(dir, "vectors.bin"))), manifest.dims);
      meta.forEach((row, i) => done.set(row.illustration_id, { row, vector: dequantize(index.q.subarray(i * index.dims, (i + 1) * index.dims), index.scales[i]) }));
    }
  }
  const progressPath = join(dir, PROGRESS);
  if (existsSync(progressPath)) {
    const recipe = recipeKey(spec);
    for (const line of readFileSync(progressPath, "utf8").split("\n")) {
      let p: ProgressLine;
      try {
        p = JSON.parse(line) as ProgressLine;
      } catch {
        continue; // blank, or cut short by a crash
      }
      if (p.recipe !== recipe) continue;
      const q = new Int8Array(Buffer.from(p.q, "base64"));
      done.set(p.row.illustration_id, { row: p.row, vector: dequantize(q, p.scale) });
    }
  }
  return done;
}

/** Record one embedded row so an interrupted build can resume. */
export function appendProgress(dir: string, spec: EmbedSpec, row: CardIndexRow, vector: Float32Array) {
  mkdirSync(dir, { recursive: true });
  const { q, scale } = quantize(vector);
  const line: ProgressLine = { recipe: recipeKey(spec), row, q: Buffer.from(q.buffer, q.byteOffset, q.byteLength).toString("base64"), scale };
  appendFileSync(join(dir, PROGRESS), JSON.stringify(line) + "\n");
}

type Extra = Pick<CardIndexManifest, "image" | "scope" | "source" | "buildSeconds">;

/** Write vectors.bin, meta.json and manifest.json (each via a temp file and rename), then drop the progress file. */
export function writeIndex(dir: string, rows: Embedded[], spec: EmbedSpec, extra: Extra): CardIndexManifest {
  mkdirSync(dir, { recursive: true });
  const manifest: CardIndexManifest = { version: 1, ...manifestFor(spec), format: "int8-rowscale", count: rows.length, builtAt: new Date().toISOString(), ...extra };
  const put = (name: string, data: string | Uint8Array) => {
    writeFileSync(join(dir, `${name}.tmp`), data);
    renameSync(join(dir, `${name}.tmp`), join(dir, name));
  };
  put("vectors.bin", encodeVectors(rows.map((r) => r.vector), spec.dims));
  put("meta.json", JSON.stringify(rows.map((r) => r.row)));
  put("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  rmSync(join(dir, PROGRESS), { force: true });
  return manifest;
}
