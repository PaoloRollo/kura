import sharp from "sharp";
import { pool, preprocess, type EmbedSpec, type Pixels } from "../../src/lib/embed-spec";

/** onnxruntime-node threads per session for every Node script and test that embeds. */
export const NODE_THREADS = 2;

export type ModelOutput = { dims: readonly number[]; data: Float32Array };

/** Decode any image Scryfall serves into packed RGB. */
export async function decodeImage(buf: Buffer): Promise<Pixels> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 3 };
}

/** The same model and preprocessing the browser runs, on onnxruntime-node. */
export async function createNodeEmbedder(spec: Pick<EmbedSpec, "model" | "arch" | "dtype" | "size" | "mean" | "std">) {
  process.env.OMP_NUM_THREADS ??= String(NODE_THREADS); // read when onnxruntime-node loads
  const { AutoModel, CLIPVisionModelWithProjection, Tensor } = await import("@huggingface/transformers");
  // Keep the machine usable: two intra-op threads, one inter-op (launch with OMP_NUM_THREADS=2 too).
  const opts = { dtype: spec.dtype, session_options: { intraOpNumThreads: NODE_THREADS, interOpNumThreads: 1 } };
  const model = spec.arch === "clip"
    ? await CLIPVisionModelWithProjection.from_pretrained(spec.model, opts)
    : await AutoModel.from_pretrained(spec.model, opts);

  /** Raw model output for a crop of the image (last_hidden_state for DINOv2, image_embeds for CLIP). */
  async function forward(img: Pixels, crop: EmbedSpec["crop"]): Promise<ModelOutput> {
    const input = preprocess(img, { ...spec, crop });
    const out = await model({ pixel_values: new Tensor("float32", input, [1, 3, spec.size, spec.size]) });
    const t = spec.arch === "clip" ? out.image_embeds : out.last_hidden_state;
    return { dims: t.dims, data: t.data as Float32Array };
  }

  return {
    forward,
    async embed(img: Pixels, full: EmbedSpec): Promise<Float32Array> {
      return pool(full, await forward(img, full.crop));
    },
  };
}
