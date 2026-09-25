import { describe, expect, it } from "vitest";
import { buildMetadata, metaCardName } from "@/lib/meta";

describe("buildMetadata", () => {
  it("shapes ERC-721 metadata from indexer and Scryfall data", () => {
    const meta = buildMetadata(
      { id: 1n, label: "black-lotus-lea-1", ensName: "black-lotus-lea-1.kura.eth", state: "whole", condition: "NM", language: "en", scryfallId: "x" },
      { name: "Black Lotus", setName: "Limited Edition Alpha", set: "lea", image: "https://img/n.jpg", collectorNumber: "232", rarity: "rare" },
      "https://kura.example",
    );
    expect(meta.name).toBe("Black Lotus (LEA) #1");
    expect(meta.image).toBe("https://img/n.jpg");
    expect(meta.external_url).toBe("https://kura.example/app/cards/1");
    expect(meta.attributes).toContainEqual({ trait_type: "ENS", value: "black-lotus-lea-1.kura.eth" });
    expect(meta.attributes).toContainEqual({ trait_type: "Condition", value: "NM" });
  });

  it("drops a trailing slash from the site base", () => {
    const meta = buildMetadata(
      { id: 7n, label: "a-b-7", ensName: "a-b-7.kura.eth", state: "sharded", condition: "LP", language: "ja", scryfallId: "y" },
      { name: "A", setName: "B", set: "b", image: "", collectorNumber: "1", rarity: "common" },
      "https://kuravault.xyz/",
    );
    expect(meta.external_url).toBe("https://kuravault.xyz/app/cards/7");
  });

  it("reads the card name back out of the metadata name", () => {
    expect(metaCardName("Black Lotus (LEA) #1")).toBe("Black Lotus");
    expect(metaCardName("Fire // Ice (APC) #12")).toBe("Fire // Ice");
    expect(metaCardName("Plain name")).toBe("Plain name");
  });
});
