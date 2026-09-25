import { describe, expect, it } from "vitest";
import { CARD_EMBED_SPEC } from "@/lib/embed-spec";
import { manifestFor, manifestMatchesSpec, type CardIndexManifest } from "@/lib/card-index-format";

const baseManifest = (over: Partial<CardIndexManifest> = {}): CardIndexManifest => ({
  version: 1,
  ...manifestFor(CARD_EMBED_SPEC),
  image: "normal",
  format: "int8-rowscale",
  count: 1,
  scope: { sets: "all", limit: null },
  source: { bulk: "unique_artwork", updatedAt: "t" },
  builtAt: "t",
  buildSeconds: 1,
  ...over,
});

describe("manifestMatchesSpec", () => {
  it("matches when the recipe and the expected image size agree", () => {
    expect(manifestMatchesSpec(baseManifest({ image: "normal" }), { ...CARD_EMBED_SPEC, image: "normal" })).toBe(true);
  });

  it("rejects a manifest built from the other Scryfall image size", () => {
    expect(manifestMatchesSpec(baseManifest({ image: "small" }), { ...CARD_EMBED_SPEC, image: "normal" })).toBe(false);
  });

  it("still rejects on a recipe mismatch even when the image size agrees", () => {
    expect(manifestMatchesSpec(baseManifest({ image: "normal", model: "someone/else" }), { ...CARD_EMBED_SPEC, image: "normal" })).toBe(false);
  });

  it("skips the image check when the spec names none, unchanged from before (index-store's resume check)", () => {
    expect(manifestMatchesSpec(baseManifest({ image: "small" }), CARD_EMBED_SPEC)).toBe(true);
  });
});
