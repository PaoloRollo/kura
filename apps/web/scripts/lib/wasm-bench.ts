import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Session = { inputNames: readonly string[]; run(feeds: Record<string, unknown>): Promise<unknown>; release(): Promise<void> };
type Ort = {
  env: { wasm: { numThreads: number } };
  InferenceSession: { create(model: Uint8Array, options: { executionProviders: string[] }): Promise<Session> };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
};

/**
 * Time one forward pass of a cached ONNX model on onnxruntime-web's WASM backend, single-threaded:
 * the browser's fallback path when WebGPU is missing and the page is not cross-origin isolated
 * (so no WASM threads). A laptop browser runs the same WASM binary, so this is a fair proxy.
 */
export async function wasmForwardMs(modelId: string, size: number, runs = 8): Promise<{ file: string; mb: number; medianMs: number }> {
  // onnxruntime-web is a dependency of transformers.js, not of this app: resolve it from there.
  const fromTransformers = createRequire(createRequire(import.meta.url).resolve("@huggingface/transformers"));
  const ort = (await import(pathToFileURL(fromTransformers.resolve("onnxruntime-web")).href)) as Ort;
  const { env } = await import("@huggingface/transformers");
  const dir = join(String(env.cacheDir), modelId, "onnx");
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith("_quantized.onnx")) : undefined;
  if (!file) throw new Error(`no quantized onnx for ${modelId} under ${dir}`);
  const bytes = readFileSync(join(dir, file));
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  const input = new ort.Tensor("float32", new Float32Array(3 * size * size).fill(0.1), [1, 3, size, size]);
  const times: number[] = [];
  for (let i = 0; i < runs + 1; i++) {
    const t0 = performance.now();
    await session.run({ [session.inputNames[0]]: input });
    if (i > 0) times.push(performance.now() - t0); // the first run includes warm-up
  }
  await session.release();
  times.sort((a, b) => a - b);
  return { file, mb: bytes.byteLength / 1e6, medianMs: times[Math.floor(times.length / 2)] };
}
