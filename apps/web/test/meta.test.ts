import { describe, expect, it } from "vitest";
import { CARD_PAGE_FALLBACK, buildMetadata, cardPageUrl, metaCardName } from "@/lib/meta";

describe("buildMetadata", () => {
  it("shapes ERC-721 metadata from indexer and Scryfall data", () => {
    const meta = buildMetadata(
      { id: 1n, label: "black-lotus-lea-1", ensName: "black-lotus-lea-1.kura.eth", state: "whole", condition: "NM", language: "en", scryfallId: "x" },
      { name: "Black Lotus", setName: "Limited Edition Alpha", set: "lea", image: "https://img/n.jpg", collectorNumber: "232", rarity: "rare" },
      "https://kura.example/app/cards/",
    );
    expect(meta.name).toBe("Black Lotus (LEA) #1");
    expect(meta.image).toBe("https://img/n.jpg");
    expect(meta.external_url).toBe("https://kura.example/app/cards/1");
    expect(meta.attributes).toContainEqual({ trait_type: "ENS", value: "black-lotus-lea-1.kura.eth" });
    expect(meta.attributes).toContainEqual({ trait_type: "Condition", value: "NM" });
  });

  it("builds card page URLs from the vault's siteURI, never localhost", () => {
    expect(cardPageUrl("https://kuravault.xyz/app/cards/", 7n)).toBe("https://kuravault.xyz/app/cards/7");
    expect(cardPageUrl(undefined, 7n)).toBe("https://kuravault.xyz/app/cards/7");
    expect(cardPageUrl("", 7n)).toBe(`${CARD_PAGE_FALLBACK}7`);
  });

  it("reads the card name back out of the metadata name", () => {
    expect(metaCardName("Black Lotus (LEA) #1")).toBe("Black Lotus");
    expect(metaCardName("Fire // Ice (APC) #12")).toBe("Fire // Ice");
    expect(metaCardName("Plain name")).toBe("Plain name");
  });
});
