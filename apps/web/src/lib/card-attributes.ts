/** One printing's attributes, served by GET /api/cards/attributes?ids= (keyed by scryfallId). */
export type CardAttributes = {
  set: string;
  setName: string;
  rarity: string;
  colors: string[];
  lang: string;
  /** Scryfall's nonfoil USD price as a decimal string, or null when Scryfall has none. */
  usd: string | null;
  /** The illustrator (Scryfall `artist`), for the credit line; null when unknown. */
  artist: string | null;
};

export type CardAttributesMap = Record<string, CardAttributes>;

/** The artist from a cached Scryfall card's raw JSON. */
export function artistOf(raw: unknown): string | null {
  const a = (raw as { artist?: unknown } | null)?.artist;
  return typeof a === "string" && a ? a : null;
}
