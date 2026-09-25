import { describe, expect, it } from "vitest";
import { indexRows } from "../scripts/lib/scryfall-bulk";

const uris = (id: string) => ({ small: `https://cards.scryfall.io/small/${id}.jpg`, normal: `https://cards.scryfall.io/normal/${id}.jpg` });
const base = {
  id: "c1", oracle_id: "o1", illustration_id: "i1", name: "Black Lotus", set: "lea", collector_number: "232", lang: "en",
  layout: "normal", games: ["paper"], image_status: "highres_scan", image_uris: uris("c1"),
};

describe("indexRows", () => {
  it("maps a single-faced paper card to one row", () => {
    expect(indexRows(base, "normal")).toEqual([
      { illustration_id: "i1", scryfall_id: "c1", oracle_id: "o1", name: "Black Lotus", set: "lea", collector_number: "232", lang: "en", face: 0, image: "https://cards.scryfall.io/normal/c1.jpg" },
    ]);
    expect(indexRows(base, "small")[0].image).toBe("https://cards.scryfall.io/small/c1.jpg");
  });

  it("indexes each illustrated face of a double-faced card", () => {
    const dfc = {
      ...base, id: "c2", name: "Delver of Secrets // Insectile Aberration", layout: "transform", illustration_id: undefined, image_uris: undefined, oracle_id: undefined,
      card_faces: [
        { name: "Delver of Secrets", illustration_id: "f1", image_uris: uris("c2-front"), oracle_id: "o2" },
        { name: "Insectile Aberration", illustration_id: "f2", image_uris: uris("c2-back"), oracle_id: "o2" },
      ],
    };
    const rows = indexRows(dfc, "normal");
    expect(rows.map((r) => [r.illustration_id, r.face, r.image, r.oracle_id, r.name])).toEqual([
      ["f1", 0, "https://cards.scryfall.io/normal/c2-front.jpg", "o2", "Delver of Secrets // Insectile Aberration"],
      ["f2", 1, "https://cards.scryfall.io/normal/c2-back.jpg", "o2", "Delver of Secrets // Insectile Aberration"],
    ]);
  });

  it("skips digital-only, non-card layouts, placeholders and missing art", () => {
    expect(indexRows({ ...base, games: ["arena"] }, "normal")).toEqual([]);
    expect(indexRows({ ...base, digital: true }, "normal")).toEqual([]);
    for (const layout of ["token", "art_series", "emblem", "double_faced_token", "vanguard"]) expect(indexRows({ ...base, layout }, "normal")).toEqual([]);
    expect(indexRows({ ...base, image_status: "placeholder" }, "normal")).toEqual([]);
    expect(indexRows({ ...base, image_status: "missing" }, "normal")).toEqual([]);
    expect(indexRows({ ...base, illustration_id: undefined }, "normal")).toEqual([]);
  });
});
