import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CardIndexRow } from "@/lib/card-index-format";
import { decodeVectors, topK } from "@/lib/card-vectors";
import { CARD_EMBED_SPEC } from "@/lib/embed-spec";
import { createNodeEmbedder, decodeImage } from "../scripts/lib/node-embedder";

// Opt-in: downloads the model (24.5 MB, cached by transformers.js) and runs it. RUN_EMBED_IT=1 to enable.
const FIXTURES = join(__dirname, "fixtures");

describe.skipIf(process.env.RUN_EMBED_IT !== "1")("card embedding (integration)", () => {
  it("embeds synthetic webcam photos in Node and finds each card top-1 in the fixture index", async () => {
    const meta = JSON.parse(readFileSync(join(FIXTURES, "card-index/meta.json"), "utf8")) as CardIndexRow[];
    const index = decodeVectors(new Uint8Array(readFileSync(join(FIXTURES, "card-index/vectors.bin"))), CARD_EMBED_SPEC.dims);
    const embedder = await createNodeEmbedder(CARD_EMBED_SPEC);
    const photos = readdirSync(join(FIXTURES, "card-photos")).filter((f) => f.endsWith(".jpg"));
    expect(photos).toHaveLength(3);
    for (const photo of photos) {
      const vector = await embedder.embed(await decodeImage(readFileSync(join(FIXTURES, "card-photos", photo))), CARD_EMBED_SPEC);
      const [best, next] = topK(index, vector, 2);
      expect(meta[best.row].illustration_id, photo).toBe(basename(photo, ".jpg"));
      expect(best.score - next.score).toBeGreaterThan(0.02);
    }
  }, 120_000);
});
