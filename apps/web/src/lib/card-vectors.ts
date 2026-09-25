/**
 * Card index vector format, shared by the Node index builder, the server matcher and the tests.
 *
 * vectors.bin = `count * dims` int8 values (row-major), then `count` little-endian float32 scales.
 * Each row is an L2-normalised embedding quantised as round(v / scale) with scale = max|v| / 127,
 * so `q * scale` recovers it to within half a step. Pure: no DOM, no Node APIs.
 */

export type VectorIndex = {
  dims: number;
  count: number;
  q: Int8Array;
  scales: Float32Array;
  /** 1 / ||q_i||, so cosine(q_i, x) = dot(q_i, x) * invNorm[i] for a unit x (the scale cancels). */
  invNorm: Float32Array;
};

export function l2normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
  const n = Math.sqrt(sum);
  if (n > 0) for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

export function quantize(v: ArrayLike<number>): { q: Int8Array; scale: number } {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
  const scale = max > 0 ? max / 127 : 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] / scale)));
  return { q, scale: Math.fround(scale) };
}

export function dequantize(q: Int8Array, scale: number): Float32Array {
  return Float32Array.from(q, (x) => x * scale);
}

export function encodeVectors(rows: ArrayLike<number>[], dims: number): Uint8Array {
  const buf = new Uint8Array(rows.length * dims + rows.length * 4);
  const q = new Int8Array(buf.buffer, 0, rows.length * dims);
  const scales = new DataView(buf.buffer, rows.length * dims);
  rows.forEach((row, i) => {
    if (row.length !== dims) throw new Error(`row ${i} has ${row.length} dims, expected ${dims}`);
    const { q: qi, scale } = quantize(row);
    q.set(qi, i * dims);
    scales.setFloat32(i * 4, scale, true);
  });
  return buf;
}

export function decodeVectors(buf: Uint8Array, dims: number): VectorIndex {
  const rowBytes = dims + 4;
  if (buf.byteLength % rowBytes !== 0) throw new Error(`vectors.bin length ${buf.byteLength} is not a multiple of ${rowBytes}`);
  const count = buf.byteLength / rowBytes;
  // Copy so the views are aligned and independent of the caller's buffer.
  const own = buf.slice();
  const q = new Int8Array(own.buffer, 0, count * dims);
  const view = new DataView(own.buffer, count * dims);
  const scales = new Float32Array(count);
  const invNorm = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    scales[i] = view.getFloat32(i * 4, true);
    let sum = 0;
    for (let d = i * dims, end = d + dims; d < end; d++) sum += q[d] * q[d];
    invNorm[i] = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  }
  return { dims, count, q, scales, invNorm };
}

export type Hit = { row: number; score: number };

/** Brute-force cosine top-k. The query need not be normalised. */
export function topK(index: VectorIndex, query: ArrayLike<number>, k: number): Hit[] {
  if (query.length !== index.dims) throw new Error(`query has ${query.length} dims, expected ${index.dims}`);
  const x = l2normalize(query);
  const { q, dims, invNorm } = index;
  const best: Hit[] = [];
  for (let i = 0; i < index.count; i++) {
    let dot = 0;
    for (let d = 0, o = i * dims; d < dims; d++) dot += q[o + d] * x[d];
    const score = dot * invNorm[i];
    if (best.length < k || score > best[best.length - 1].score) {
      let j = Math.min(best.length, k - 1);
      best[j] = { row: i, score };
      while (j > 0 && best[j - 1].score < score) {
        [best[j - 1], best[j]] = [best[j], best[j - 1]];
        j--;
      }
    }
  }
  return best;
}
