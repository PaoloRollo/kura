import { describe, expect, it } from "vitest";
import { CARD_EMBED_SPEC, CONFIDENT_MARGIN, CONFIDENT_SCORE, isConfident, pool, preprocess, type EmbedSpec } from "@/lib/embed-spec";

const spec = (over: Partial<EmbedSpec>): EmbedSpec => ({ ...CARD_EMBED_SPEC, size: 2, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], crop: { x: 0, y: 0, w: 1, h: 1 }, ...over });

/** 4x4 RGBA image: top half white, bottom half black; the top-left pixel is pure red. */
function image() {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const v = y < 2 ? 255 : 0;
    data.set([v, v, v, 255], (y * 4 + x) * 4);
  }
  data.set([255, 0, 0, 255], 0);
  return { data, width: 4, height: 4, channels: 4 as const };
}

describe("preprocess", () => {
  it("box-averages the crop to size x size and normalises into CHW", () => {
    const out = preprocess(image(), spec({}));
    expect(out).toHaveLength(3 * 2 * 2);
    // Output pixel (0,0) averages the 2x2 top-left block: one red, three white.
    const r = (255 * 4) / 4 / 255, g = (255 * 3) / 4 / 255;
    expect(out[0]).toBeCloseTo((r - 0.5) / 0.5, 5);
    expect(out[4]).toBeCloseTo((g - 0.5) / 0.5, 5);
    expect(out[1]).toBeCloseTo(1, 5); // top-right: white
    expect(out[2]).toBeCloseTo(-1, 5); // bottom-left: black
  });

  it("applies the crop in card fractions, and reads RGB input too", () => {
    const top = preprocess(image(), spec({ crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } }));
    expect(Array.from(top).every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
    const rgb = { data: new Uint8Array([0, 0, 0, 255, 255, 255]), width: 2, height: 1, channels: 3 as const };
    const out = preprocess(rgb, spec({ size: 1 }));
    expect(Array.from(out)).toEqual([0, 0, 0].map(() => expect.closeTo(0, 5)));
  });
});

describe("pool", () => {
  const hidden = { dims: [1, 3, 2], data: new Float32Array([3, 4, 1, 0, 0, 1]) };
  it("takes the CLS token or the patch mean, L2-normalised", () => {
    expect(Array.from(pool({ ...CARD_EMBED_SPEC, pooling: "cls" }, hidden))).toEqual([expect.closeTo(0.6, 5), expect.closeTo(0.8, 5)]);
    expect(Array.from(pool({ ...CARD_EMBED_SPEC, pooling: "mean" }, hidden))).toEqual([expect.closeTo(Math.SQRT1_2, 5), expect.closeTo(Math.SQRT1_2, 5)]);
    expect(pool({ ...CARD_EMBED_SPEC, pooling: "cls+mean" }, hidden)).toHaveLength(4);
    expect(Array.from(pool({ ...CARD_EMBED_SPEC, pooling: "embeds" }, { dims: [1, 2], data: new Float32Array([0, 2]) }))).toEqual([0, 1]);
  });
});

describe("isConfident", () => {
  it("needs a high best score that is clearly ahead of the next artwork", () => {
    expect(isConfident([])).toBe(false);
    expect(isConfident([CONFIDENT_SCORE + 0.05])).toBe(true);
    expect(isConfident([CONFIDENT_SCORE + 0.05, CONFIDENT_SCORE + 0.05 - CONFIDENT_MARGIN - 0.001])).toBe(true);
    expect(isConfident([CONFIDENT_SCORE + 0.05, CONFIDENT_SCORE + 0.04])).toBe(false); // too close to call
    expect(isConfident([CONFIDENT_SCORE - 0.01, 0.2])).toBe(false); // clear winner, but a weak match
  });
});
