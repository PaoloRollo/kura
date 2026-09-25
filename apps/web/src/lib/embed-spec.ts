/**
 * The card-embedding recipe, shared byte for byte by the browser (query) and the Node index builder.
 * Preprocessing is done here in plain JS rather than by the library's image processor, so that the
 * crop, resampling and normalisation are identical in both runtimes. Pure: no DOM, no Node APIs.
 */
import { l2normalize } from "./card-vectors";

/** A region of the card image, in fractions of its width and height. */
export type Crop = { x: number; y: number; w: number; h: number };

export type EmbedSpec = {
  /** Hugging Face model id, loaded with transformers.js. */
  model: string;
  /** "dinov2": AutoModel, last_hidden_state. "clip": CLIPVisionModelWithProjection, image_embeds. */
  arch: "dinov2" | "clip";
  dtype: "q8";
  size: number;
  mean: [number, number, number];
  std: [number, number, number];
  crop: Crop;
  pooling: "cls" | "mean" | "cls+mean" | "embeds";
  dims: number;
};

export const IMAGENET_MEAN: [number, number, number] = [0.485, 0.456, 0.406];
export const IMAGENET_STD: [number, number, number] = [0.229, 0.224, 0.225];
export const CLIP_MEAN: [number, number, number] = [0.48145466, 0.4578275, 0.40821073];
export const CLIP_STD: [number, number, number] = [0.26862954, 0.26130258, 0.27577711];

export const FULL_CARD: Crop = { x: 0, y: 0, w: 1, h: 1 };
/** Roughly the top 55% of the card: name bar and art box. */
export const ART_TOP: Crop = { x: 0, y: 0, w: 1, h: 0.55 };

/**
 * The recipe the shipped index is built with, chosen by scripts/eval-embeddings.mts: DINOv2-small
 * (q8, 24.5 MB) on the top 55% of the card, mean-pooled patch tokens. It had 100% top-1 on 300
 * synthetic webcam photos against 2,060 artworks; the full card and CLS pooling both measured worse.
 */
export const CARD_EMBED_SPEC: EmbedSpec = {
  model: "Xenova/dinov2-small",
  arch: "dinov2",
  dtype: "q8",
  size: 224,
  mean: IMAGENET_MEAN,
  std: IMAGENET_STD,
  crop: ART_TOP,
  pooling: "mean",
  dims: 384,
};

export type Pixels = { data: ArrayLike<number>; width: number; height: number; channels: 3 | 4 };

/** Per output index, the source indices and weights of an area-averaging (box) resample. */
function boxWeights(srcStart: number, srcLen: number, outLen: number, srcMax: number) {
  const step = srcLen / outLen;
  return Array.from({ length: outLen }, (_, o) => {
    const a = srcStart + o * step;
    const b = a + step;
    const taps: [number, number][] = [];
    for (let s = Math.floor(a); s < Math.ceil(b); s++) {
      const w = Math.min(b, s + 1) - Math.max(a, s);
      if (w > 1e-9) taps.push([Math.min(srcMax - 1, Math.max(0, s)), w / step]);
    }
    return taps;
  });
}

/** Crop, box-resample to size x size and normalise into a CHW float tensor. */
export function preprocess(img: Pixels, spec: Pick<EmbedSpec, "size" | "mean" | "std" | "crop">): Float32Array {
  const { width, height, channels, data } = img;
  const { size, mean, std, crop } = spec;
  const cols = boxWeights(crop.x * width, crop.w * width, size, width);
  const rows = boxWeights(crop.y * height, crop.h * height, size, height);
  // Horizontal pass over the source rows the crop touches.
  const y0 = rows[0][0][0];
  const y1 = rows[size - 1][rows[size - 1].length - 1][0];
  const tmp = new Float32Array((y1 - y0 + 1) * size * 3);
  for (let y = y0; y <= y1; y++) {
    for (let ox = 0; ox < size; ox++) {
      let r = 0, g = 0, b = 0;
      for (const [sx, w] of cols[ox]) {
        const p = (y * width + sx) * channels;
        r += data[p] * w;
        g += data[p + 1] * w;
        b += data[p + 2] * w;
      }
      const t = ((y - y0) * size + ox) * 3;
      tmp[t] = r;
      tmp[t + 1] = g;
      tmp[t + 2] = b;
    }
  }
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let r = 0, g = 0, b = 0;
      for (const [sy, w] of rows[oy]) {
        const t = ((sy - y0) * size + ox) * 3;
        r += tmp[t] * w;
        g += tmp[t + 1] * w;
        b += tmp[t + 2] * w;
      }
      const o = oy * size + ox;
      out[o] = (r / 255 - mean[0]) / std[0];
      out[plane + o] = (g / 255 - mean[1]) / std[1];
      out[2 * plane + o] = (b / 255 - mean[2]) / std[2];
    }
  }
  return out;
}

/** Turn the model output into the L2-normalised card vector. */
export function pool(spec: Pick<EmbedSpec, "pooling">, out: { dims: readonly number[]; data: ArrayLike<number> }): Float32Array {
  if (spec.pooling === "embeds") return l2normalize(out.data);
  const [, tokens, dims] = out.dims;
  const cls = Array.from({ length: dims }, (_, d) => out.data[d]);
  const mean = new Array<number>(dims).fill(0);
  for (let t = 1; t < tokens; t++) for (let d = 0; d < dims; d++) mean[d] += out.data[t * dims + d] / (tokens - 1);
  if (spec.pooling === "cls") return l2normalize(cls);
  if (spec.pooling === "mean") return l2normalize(mean);
  return l2normalize([...l2normalize(cls), ...l2normalize(mean)]);
}

/**
 * Low-confidence cut-offs for CARD_EMBED_SPEC, picked from the eval's open-set analysis (photos of
 * cards whose artwork is not in the index): a match is preselected only when the best score is high
 * AND clearly ahead of the next artwork. Otherwise the station says "Not sure — pick or search".
 */
export const CONFIDENT_SCORE = 0.8;
export const CONFIDENT_MARGIN = 0.03;

/** Whether the best of these ranked scores (one per distinct artwork, best first) is a confident match. */
export function isConfident(scores: readonly number[]): boolean {
  if (scores.length === 0) return false;
  const margin = scores.length > 1 ? scores[0] - scores[1] : Infinity;
  return scores[0] >= CONFIDENT_SCORE && margin >= CONFIDENT_MARGIN;
}
