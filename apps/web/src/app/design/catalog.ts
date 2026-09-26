// Dev-only fixture catalog for the collector list previews (/design/explore, /design/vault, /design/portfolio): cards
// with local art and Scryfall-like attributes, and row builders shaped like the indexer's (ponder.schema.ts).
import { usdcPerShardToQ96 } from "@kura/shared";
import type { CardAttributes } from "@/lib/card-attributes";
import { AIKO, HANDLES, KENJI, PAOLO, X7A3 } from "./card/fixtures";

type Hex = `0x${string}`;
export const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
export const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
export const S = 10n ** 18n;
export const usd = (dollars: number) => BigInt(Math.round(dollars * 100)) * 10_000n;
/** The fixtures' head block; `now` is its timestamp. */
export const HEAD = 7_412_880n;
export const blocksFromSeconds = (s: number) => BigInt(Math.round(s / 12));

export const REN: Hex = "0x9e1d7c0a5b3f2e4d6c8a0b1f3e5d7c9a1b3e5f70";
export { AIKO, KENJI, PAOLO, X7A3 };
export const PREVIEW_HANDLES = { ...HANDLES, [REN.toLowerCase()]: "ren" };

type Entry = { name: string; image: string; set: string; setName: string; rarity: string; colors: string[]; number: string; artist: string };
export const CATALOG = {
  lotus: { name: "Black Lotus", image: "/cards/black-lotus.webp", set: "lea", setName: "Limited Edition Alpha", rarity: "rare", colors: [], number: "232", artist: "Christopher Rush" },
  recall: { name: "Ancestral Recall", image: "/cards/ancestral-recall.webp", set: "lea", setName: "Limited Edition Alpha", rarity: "rare", colors: ["U"], number: "48", artist: "Mark Poole" },
  jace: { name: "Jace, the Mind Sculptor", image: "/cards/jace-the-mind-sculptor.webp", set: "wwk", setName: "Worldwake", rarity: "mythic", colors: ["U"], number: "31", artist: "Jason Chan" },
  force: { name: "Force of Will", image: "/cards/force-of-will.webp", set: "all", setName: "Alliances", rarity: "uncommon", colors: ["U"], number: "28", artist: "Terese Nielsen" },
  mox: { name: "Mox Sapphire", image: "/cards/mox-sapphire.webp", set: "lea", setName: "Limited Edition Alpha", rarity: "rare", colors: [], number: "265", artist: "Dan Frazier" },
  walk: { name: "Time Walk", image: "/cards/time-walk.webp", set: "leb", setName: "Limited Edition Beta", rarity: "rare", colors: ["U"], number: "84", artist: "Amy Weber" },
  solring: { name: "Sol Ring", image: "/cards/sol-ring.webp", set: "2ed", setName: "Unlimited Edition", rarity: "uncommon", colors: [], number: "274", artist: "Mark Tedin" },
} satisfies Record<string, Entry>;
export type CatalogKey = keyof typeof CATALOG;

export type CardSpec = { id: number; key: CatalogKey; condition?: string; language?: string; owner: Hex; ownerOf?: Hex; state: "whole" | "auctioning" | "sharded" | "released"; mintedAgo: number };

export function cardRow(c: CardSpec, now: number) {
  const e = CATALOG[c.key];
  const label = `${e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}-${e.set}-${c.id}`;
  return {
    id: BigInt(c.id), state: c.state, ownerOf: c.ownerOf ?? c.owner, beneficialOwner: c.owner, scryfallId: `fixture-${c.key}`,
    condition: c.condition ?? "NM", language: c.language ?? "en", label, ensName: `${label}.kura.eth`,
    shardToken: null as Hex | null, auction: null as Hex | null, endBlock: null as bigint | null,
    mintedAt: now - c.mintedAgo, updatedBlock: HEAD, updatedAt: now - 60,
  };
}

export const metaOf = (id: number, key: CatalogKey) => ({ name: `${CATALOG[key].name} (${CATALOG[key].set.toUpperCase()}) #${id}`, image: CATALOG[key].image });

export function attributesOf(keys: readonly CatalogKey[]): Record<string, CardAttributes> {
  return Object.fromEntries(keys.map((k) => {
    const e = CATALOG[k];
    return [`fixture-${k}`, { set: e.set, setName: e.setName, rarity: e.rarity, colors: e.colors, lang: "en", usd: null, artist: e.artist }];
  }));
}

export type ShardingSpec = {
  id: number;
  totalShards: number;
  forSale: number;
  floor: number;
  clearing: number | null;
  /** Seconds since the auction opened, and its length in seconds. */
  openedAgo: number;
  length: number;
  settled?: boolean;
  graduated?: boolean | null;
  buyout?: number;
  redeemer?: Hex;
  settledAgo?: number;
};

export function shardingRow(s: ShardingSpec, now: number) {
  const startBlock = HEAD - blocksFromSeconds(s.openedAgo);
  const endBlock = startBlock + blocksFromSeconds(s.length);
  const settled = s.settled ?? false;
  const graduated = s.graduated === undefined ? (settled ? true : null) : s.graduated;
  const clearing = graduated === false || s.clearing == null ? null : usd(s.clearing);
  return {
    shardToken: addr(0x5a000 + s.id), cardId: BigInt(s.id), auction: addr(0xa0000 + s.id), totalShards: s.totalShards, forSale: s.forSale,
    floorPriceQ96: usdcPerShardToQ96(usd(s.floor)), tickSpacingQ96: usdcPerShardToQ96(usd(1)), reserveUsdc: usd(s.floor * s.forSale),
    startBlock, endBlock, settled, graduated,
    clearingPriceQ96: s.clearing != null ? usdcPerShardToQ96(usd(s.clearing)) : null, clearingUsdcPerShard: clearing,
    raisedUsdc: settled && clearing ? clearing * BigInt(s.forSale) : null, feeUsdc: settled && clearing ? (clearing * BigInt(s.forSale) * 250n) / 10_000n : null,
    buyoutPerShard: s.buyout != null ? usd(s.buyout) : null, payoutUsdc: null as bigint | null, redeemer: s.redeemer ?? null,
    createdAt: now - s.openedAgo, updatedBlock: HEAD, updatedAt: now - (s.settledAgo ?? 60),
  };
}

export const activeRow = (s: ReturnType<typeof shardingRow>) => ({
  auction: s.auction, cardId: s.cardId, shardToken: s.shardToken, startBlock: s.startBlock, endBlock: s.endBlock, blockNumber: s.startBlock, timestamp: s.createdAt,
});
