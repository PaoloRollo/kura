import { describe, expect, it } from "vitest";
import { parseJsonArray } from "../scripts/lib/json-array-stream";

const enc = (s: string) => new TextEncoder().encode(s);

async function collect(chunks: Uint8Array[]) {
  async function* source() {
    yield* chunks;
  }
  const out: unknown[] = [];
  for await (const o of parseJsonArray(source())) out.push(o);
  return out;
}

describe("parseJsonArray", () => {
  const items = [{ a: 1, s: "x}{,]\"q\"" }, { nested: { b: [1, { c: "}" }] }, name: "Æther Vial — 日本語" }, { e: "\\" }];
  const text = JSON.stringify(items, null, 1);

  it("yields each top-level object however the bytes are split", async () => {
    expect(await collect([enc(text)])).toEqual(items);
    const bytes = enc(text);
    for (const size of [1, 2, 3, 7]) {
      // Split on byte boundaries, including inside multi-byte characters.
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
      expect(await collect(chunks)).toEqual(items);
    }
  });

  it("handles an empty array and rejects a non-array", async () => {
    expect(await collect([enc("[ ]")])).toEqual([]);
    await expect(collect([enc('{"a":1}')])).rejects.toThrow(/array/);
  });
});
