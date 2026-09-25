import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeVectors, dequantize, encodeVectors, l2normalize, quantize, topK } from "@/lib/card-vectors";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
const randomVec = (r: () => number, dims: number) => l2normalize(Float32Array.from({ length: dims }, r));
const cosine = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

describe("card vectors", () => {
  it("l2-normalises, and leaves a zero vector at zero", () => {
    const v = l2normalize([3, 4]);
    expect(Array.from(v)).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6)]);
    expect(Array.from(l2normalize([0, 0]))).toEqual([0, 0]);
  });

  it("quantises to int8 with a per-vector scale that round-trips within one step", () => {
    const v = randomVec(rng(1), 384);
    const { q, scale } = quantize(v);
    expect(q).toBeInstanceOf(Int8Array);
    expect(Math.max(...Array.from(q, Math.abs))).toBe(127);
    const back = dequantize(q, scale);
    for (let i = 0; i < v.length; i++) expect(Math.abs(back[i] - v[i])).toBeLessThanOrEqual(scale / 2 + 1e-7);
    expect(cosine(l2normalize(back), v)).toBeGreaterThan(0.9999);
  });

  it("encodes and decodes a vectors.bin buffer, rejecting a truncated one", () => {
    const r = rng(2);
    const rows = [randomVec(r, 8), randomVec(r, 8), randomVec(r, 8)];
    const buf = encodeVectors(rows, 8);
    expect(buf.byteLength).toBe(3 * 8 + 3 * 4);
    const index = decodeVectors(buf, 8);
    expect(index.count).toBe(3);
    for (let i = 0; i < 3; i++) {
      const { q, scale } = quantize(rows[i]);
      expect(Array.from(index.q.subarray(i * 8, i * 8 + 8))).toEqual(Array.from(q));
      expect(index.scales[i]).toBeCloseTo(scale, 7);
    }
    expect(() => decodeVectors(buf.subarray(0, buf.byteLength - 1), 8)).toThrow(/length/);
    expect(() => encodeVectors([new Float32Array(4)], 8)).toThrow(/dims/);
  });

  it("ranks rows by cosine similarity and returns the top k", () => {
    const r = rng(3);
    const rows = Array.from({ length: 50 }, () => randomVec(r, 64));
    const index = decodeVectors(encodeVectors(rows, 64), 64);
    // A noisy, unnormalised copy of row 17 should still find row 17 first.
    const query = Float32Array.from(rows[17], (x) => 5 * (x + 0.02 * r()));
    const hits = topK(index, query, 5);
    expect(hits).toHaveLength(5);
    expect(hits[0].row).toBe(17);
    expect(hits[0].score).toBeGreaterThan(0.99);
    for (let i = 1; i < hits.length; i++) expect(hits[i].score).toBeLessThanOrEqual(hits[i - 1].score);
    // Exact cosine against the dequantised rows gives the same order.
    const exact = rows.map((v, row) => { const { q, scale } = quantize(v); return { row, score: cosine(l2normalize(dequantize(q, scale)), l2normalize(query)) }; }).sort((a, b) => b.score - a.score).slice(0, 5);
    expect(hits.map((h) => h.row)).toEqual(exact.map((h) => h.row));
    expect(topK(index, query, 500)).toHaveLength(50);
    expect(() => topK(index, new Float32Array(3), 5)).toThrow(/dims/);
  });
});

describe("fixture card index", () => {
  const dir = join(__dirname, "fixtures/card-index");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { dims: number; count: number };
  const index = decodeVectors(new Uint8Array(readFileSync(join(dir, "vectors.bin"))), manifest.dims);

  it("decodes with the manifest's count and finds every row as its own nearest neighbour", () => {
    expect(index.count).toBe(manifest.count);
    expect(index.count).toBeLessThanOrEqual(200);
    for (let i = 0; i < index.count; i++) {
      const own = dequantize(index.q.subarray(i * index.dims, (i + 1) * index.dims), index.scales[i]);
      const [best, next] = topK(index, own, 2);
      expect(best.row).toBe(i);
      expect(best.score).toBeCloseTo(1, 5);
      expect(next.score).toBeLessThan(0.99);
    }
  });
});
