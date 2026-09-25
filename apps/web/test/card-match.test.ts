import { describe, expect, it } from "vitest";
import { groupSiblings } from "@/lib/card-match";
import type { CardIndexRow } from "@/lib/card-index-format";
import type { ScryfallCard } from "@/lib/scryfall";

const row = (over: Partial<CardIndexRow>): CardIndexRow => ({ illustration_id: "ill-lotus", scryfall_id: "lea-lotus", oracle_id: "o", name: "Black Lotus", set: "lea", collector_number: "232", lang: "en", face: 0, image: "i", ...over });
const card = (id: string, set: string, released: string, illustration: string | undefined, over: Partial<ScryfallCard> = {}): ScryfallCard => ({
  id, name: "Black Lotus", lang: "en", set, set_name: set.toUpperCase(), collector_number: "1", rarity: "rare", released_at: released,
  illustration_id: illustration, prices: {}, ...over,
});

describe("groupSiblings", () => {
  const lotusPrintings = [
    card("vma-lotus", "vma", "2014-06-16", "ill-vma"),
    card("2ed-lotus", "2ed", "1993-12-01", "ill-lotus"),
    card("lea-lotus", "lea", "1993-08-05", "ill-lotus"),
    card("leb-lotus", "leb", "1993-10-04", "ill-lotus"),
    card("leb-lotus-ja", "leb", "1993-10-04", "ill-lotus", { lang: "ja" }),
  ];

  it("collects every printing of the matched illustration, oldest first, with the indexed printing as primary", () => {
    const [g] = groupSiblings([{ row: row({ scryfall_id: "leb-lotus" }), score: 0.9 }], new Map([["Black Lotus", lotusPrintings]]));
    expect(g.kind).toBe("ok");
    if (g.kind !== "ok") return;
    expect(g.primary.id).toBe("leb-lotus");
    expect(g.siblings.map((c) => c.id)).toEqual(["lea-lotus", "leb-lotus", "leb-lotus-ja", "2ed-lotus"]);
    expect(g.score).toBe(0.9);
  });

  it("keeps different artworks of one name apart, collapses repeated illustrations, and matches back faces", () => {
    const dfc = card("dfc", "isd", "2011-09-30", undefined, { name: "Delver of Secrets // Insectile Aberration", card_faces: [{ illustration_id: "front" }, { illustration_id: "back" }] });
    const groups = groupSiblings(
      [
        { row: row({}), score: 0.8 },
        { row: row({ illustration_id: "ill-vma", scryfall_id: "vma-lotus" }), score: 0.7 },
        { row: row({ scryfall_id: "leb-lotus" }), score: 0.6 },
        { row: row({ illustration_id: "back", scryfall_id: "dfc", name: dfc.name, face: 1 }), score: 0.5 },
      ],
      new Map([["Black Lotus", lotusPrintings], [dfc.name, [dfc]]]),
    );
    expect(groups.map((g) => (g.kind === "ok" ? [g.primary.id, g.siblings.length] : g.kind))).toEqual([["lea-lotus", 4], ["vma-lotus", 1], ["dfc", 1]]);
  });

  it("reports hits whose printings failed to load or are missing from the list", () => {
    const boom = new Error("scryfall 500");
    const groups = groupSiblings(
      [
        { row: row({}), score: 0.9 },
        { row: row({ name: "Mox Pearl", illustration_id: "ill-mox", scryfall_id: "mox" }), score: 0.8 },
        { row: row({ name: "Island", illustration_id: "ill-island", scryfall_id: "island-9" }), score: 0.7 },
      ],
      new Map<string, ScryfallCard[] | Error>([["Black Lotus", lotusPrintings], ["Mox Pearl", boom], ["Island", []]]),
    );
    expect(groups.map((g) => g.kind)).toEqual(["ok", "failed", "missing"]);
    expect(groups[1]).toMatchObject({ kind: "failed", error: boom });
  });
});
