/** On-disk card index layout (data/card-index): manifest.json, meta.json, vectors.bin. Pure types and checks. */
import type { EmbedSpec } from "./embed-spec";

/** One row of the card index: one illustration of one printing. Row i of meta.json is row i of vectors.bin. */
export type CardIndexRow = {
  illustration_id: string;
  scryfall_id: string;
  oracle_id: string | null;
  name: string;
  set: string;
  collector_number: string;
  lang: string;
  /** Which face's art this row is (0 for single-faced cards). */
  face: number;
  image: string;
};

export type CardIndexManifest = {
  version: 1;
  model: string;
  arch: EmbedSpec["arch"];
  dtype: EmbedSpec["dtype"];
  dims: number;
  preprocessing: { size: number; crop: EmbedSpec["crop"]; mean: number[]; std: number[]; pooling: EmbedSpec["pooling"]; resample: "box" };
  /** Which Scryfall image size was embedded. */
  image: "small" | "normal";
  format: "int8-rowscale";
  count: number;
  scope: { sets: string[] | "all"; limit: number | null };
  source: { bulk: string; updatedAt: string };
  builtAt: string;
  buildSeconds: number;
};

export function manifestFor(spec: EmbedSpec): Pick<CardIndexManifest, "model" | "arch" | "dtype" | "dims" | "preprocessing"> {
  return {
    model: spec.model,
    arch: spec.arch,
    dtype: spec.dtype,
    dims: spec.dims,
    preprocessing: { size: spec.size, crop: spec.crop, mean: [...spec.mean], std: [...spec.std], pooling: spec.pooling, resample: "box" },
  };
}

/** True when an index was built with exactly this embedding recipe, so its vectors are comparable to queries. */
export function manifestMatchesSpec(m: Pick<CardIndexManifest, "model" | "arch" | "dtype" | "dims" | "preprocessing">, spec: EmbedSpec): boolean {
  return JSON.stringify(manifestFor(spec)) === JSON.stringify({ model: m.model, arch: m.arch, dtype: m.dtype, dims: m.dims, preprocessing: m.preprocessing });
}
