import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { l2normalize } from "@/lib/card-vectors";
import { CARD_EMBED_SPEC } from "@/lib/embed-spec";
import { appendProgress, readEmbedded, writeIndex } from "../scripts/lib/index-store";

const dims = CARD_EMBED_SPEC.dims;
const row = (id: string) => ({ illustration_id: id, scryfall_id: `s-${id}`, oracle_id: null, name: id, set: "lea", collector_number: "1", lang: "en", face: 0, image: `https://img/${id}.jpg` });
const vec = (seed: number) => l2normalize(Float32Array.from({ length: dims }, (_, i) => Math.sin(seed * 31 + i)));
const extra = { image: "normal" as const, scope: { sets: ["lea"], limit: null }, source: { bulk: "unique_artwork", updatedAt: "t" }, buildSeconds: 1 };

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("index store", () => {
  it("resumes from the finished index and the progress file, for the same recipe only", () => {
    dir = mkdtempSync(join(tmpdir(), "card-index-"));
    writeIndex(dir, [{ row: row("a"), vector: vec(1) }], CARD_EMBED_SPEC, extra);
    appendProgress(dir, CARD_EMBED_SPEC, row("b"), vec(2));
    appendProgress(dir, CARD_EMBED_SPEC, row("c"), vec(3));
    writeFileSync(join(dir, "progress.jsonl"), '{"truncated', { flag: "a" }); // a crash mid-line is ignored

    const done = readEmbedded(dir, CARD_EMBED_SPEC);
    expect([...done.keys()].sort()).toEqual(["a", "b", "c"]);
    const b = done.get("b")!;
    expect(b.row.scryfall_id).toBe("s-b");
    // Vectors come back through int8, so they are close but not identical.
    expect(b.vector.reduce((s, x, i) => s + x * vec(2)[i], 0)).toBeGreaterThan(0.999);

    expect(readEmbedded(dir, { ...CARD_EMBED_SPEC, pooling: "cls" }).size).toBe(0);
  });

  it("writes vectors, meta and manifest that agree, and clears the progress file", async () => {
    dir = mkdtempSync(join(tmpdir(), "card-index-"));
    appendProgress(dir, CARD_EMBED_SPEC, row("x"), vec(9));
    const manifest = writeIndex(dir, [{ row: row("a"), vector: vec(1) }, { row: row("b"), vector: vec(2) }], CARD_EMBED_SPEC, extra);
    expect(manifest).toMatchObject({ count: 2, dims, model: CARD_EMBED_SPEC.model, format: "int8-rowscale" });
    const { readFileSync, existsSync } = await import("node:fs");
    expect(readFileSync(join(dir, "vectors.bin")).byteLength).toBe(2 * (dims + 4));
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).map((r: { illustration_id: string }) => r.illustration_id)).toEqual(["a", "b"]);
    expect(existsSync(join(dir, "progress.jsonl"))).toBe(false);
  });
});
