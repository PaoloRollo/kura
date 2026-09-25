/**
 * In-browser card embedding (client only: never import this from server code).
 * transformers.js is loaded lazily with a dynamic import, so it stays out of the server bundle and
 * out of the page's initial chunk. One model instance is shared by the whole page.
 */
import { CARD_EMBED_SPEC, pool, preprocess, type EmbedSpec } from "@/lib/embed-spec";

export type LoadProgress = { file: string; loaded: number; total: number };
type Forward = (pixelValues: Float32Array) => Promise<{ dims: readonly number[]; data: ArrayLike<number> }>;
type Embedder = { device: "webgpu" | "wasm"; forward: Forward };

let embedder: Promise<Embedder> | null = null;
const listeners = new Set<(p: LoadProgress) => void>();

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

async function load(spec: EmbedSpec): Promise<Embedder> {
  if (typeof window === "undefined") throw new Error("card-embed runs in the browser only");
  const { AutoModel, CLIPVisionModelWithProjection, Tensor, env } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  const progress_callback = (e: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (e.status === "progress" && e.file && e.total) for (const l of listeners) l({ file: e.file, loaded: e.loaded ?? 0, total: e.total });
  };
  const create = (device: "webgpu" | "wasm") => {
    const opts = { dtype: spec.dtype, device, progress_callback };
    return spec.arch === "clip" ? CLIPVisionModelWithProjection.from_pretrained(spec.model, opts) : AutoModel.from_pretrained(spec.model, opts);
  };
  const devices: ("webgpu" | "wasm")[] = (await hasWebGpu()) ? ["webgpu", "wasm"] : ["wasm"];
  let lastError: unknown;
  for (const device of devices) {
    try {
      const model = await create(device);
      const forward: Forward = async (pixelValues) => {
        const out = await model({ pixel_values: new Tensor("float32", pixelValues, [1, 3, spec.size, spec.size]) });
        const t = spec.arch === "clip" ? out.image_embeds : out.last_hidden_state;
        return { dims: t.dims, data: t.data as Float32Array };
      };
      // Warm-up run: compiles shaders / kernels so the first real scan is fast, and proves the device works.
      await forward(new Float32Array(3 * spec.size * spec.size));
      return { device, forward };
    } catch (e) {
      lastError = e; // e.g. an op WebGPU cannot run: fall back to WASM
    }
  }
  throw lastError;
}

/** Start (or join) loading the shared model. Resolves with the device it runs on. */
export function warmUpEmbedder(onProgress?: (p: LoadProgress) => void): Promise<"webgpu" | "wasm"> {
  if (onProgress) listeners.add(onProgress);
  if (!embedder) {
    embedder = load(CARD_EMBED_SPEC);
    embedder.catch(() => {
      embedder = null; // let a later call retry
    });
  }
  return embedder.then(
    (e) => {
      if (onProgress) listeners.delete(onProgress);
      return e.device;
    },
    (err) => {
      if (onProgress) listeners.delete(onProgress);
      throw err;
    },
  );
}

/** Embed a canvas holding just the card (cropped from the capture guide). Same recipe as the index builder. */
export async function embedCard(card: HTMLCanvasElement): Promise<number[]> {
  await warmUpEmbedder();
  const e = await embedder!;
  const ctx = card.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2d context unavailable");
  const img = ctx.getImageData(0, 0, card.width, card.height);
  const input = preprocess({ data: img.data, width: img.width, height: img.height, channels: 4 }, CARD_EMBED_SPEC);
  return Array.from(pool(CARD_EMBED_SPEC, await e.forward(input)));
}
