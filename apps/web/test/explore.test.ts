import { describe, expect, it } from "vitest";
import { usdcPerShardToQ96 } from "@kura/shared";
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  buildAuctionItems,
  elapsed,
  exploreResults,
  filtersToQuery,
  fold,
  shortAgo,
  inTab,
  matchesSearch,
  parseFilters,
  vsBand,
  type ExploreFilters,
} from "@/lib/explore";

const usd = (d: number) => BigInt(Math.round(d * 100)) * 10_000n;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const BLOCK = 1_000n;

function sharding(n: number, p: Partial<Parameters<typeof buildAuctionItems>[0]["shardings"][number]> = {}) {
  return {
    shardToken: addr(0x100 + n), cardId: BigInt(n), auction: addr(0x200 + n), totalShards: 16, forSale: 3,
    floorPriceQ96: usdcPerShardToQ96(usd(1500)), startBlock: 0n, endBlock: 2_000n, settled: false, graduated: null,
    clearingPriceQ96: null, clearingUsdcPerShard: usd(1712), updatedAt: 100 + n, ...p,
  };
}
const card = (n: number, p: Partial<{ condition: string; language: string }> = {}) => ({
  id: BigInt(n), scryfallId: `s${n}`, condition: "NM", language: "en", label: `card-${n}`, ensName: `card-${n}.kura.eth`, ...p,
});

function fixture() {
  const shardings = [
    sharding(1),
    sharding(2, { endBlock: 1_200n, clearingUsdcPerShard: usd(662), totalShards: 32 }),
    sharding(3, { endBlock: 900n }),
    sharding(4, { settled: true, graduated: true, updatedAt: 500 }),
    sharding(5, { settled: true, graduated: false, clearingUsdcPerShard: null, updatedAt: 600 }),
  ];
  const active = shardings.slice(0, 3).map((s) => ({ auction: s.auction, cardId: s.cardId, shardToken: s.shardToken, startBlock: s.startBlock, endBlock: s.endBlock }));
  return buildAuctionItems({
    active,
    shardings,
    cards: [card(1), card(2, { condition: "LP", language: "ja" }), card(3), card(4), card(5)],
    metas: new Map([["1", { name: "Black Lotus (LEA) #1", image: "/l.jpg" }], ["2", { name: "Ancestral Recall (LEA) #2", image: "/a.jpg" }]]),
    attributes: { s1: { set: "lea", setName: "Limited Edition Alpha", rarity: "rare", colors: [] }, s2: { set: "leb", setName: "Limited Edition Beta", rarity: "rare", colors: ["U"] } },
    // Market per shard: $1,562.50 for card 1 (clearing +9.6%), $700 for card 2 (clearing -5.4%).
    markets: new Map([["1", usd(25_000)], ["2", usd(22_400)]]),
    block: BLOCK,
  });
}

describe("explore items", () => {
  it("joins cards and shardings and splits live, awaiting settle and settled", () => {
    const items = fixture();
    expect(items.map((i) => [i.cardId, i.status])).toEqual([[1n, "live"], [2n, "live"], [3n, "awaiting"], [5n, "settled"], [4n, "settled"]]);
    expect(items[0]).toMatchObject({ name: "Black Lotus", set: "LEA", clearing: usd(1712) });
    expect(items[0]!.premium).toBeCloseTo(0.0956, 3);
    // Not graduated: no clearing price.
    expect(items.find((i) => i.cardId === 5n)!.clearing).toBeNull();
  });

  it("prices a settled card at its live pool, and compares that to the market", () => {
    const shardings = [sharding(1, { settled: true, graduated: true })];
    const base = { active: [], shardings, cards: [card(1)], metas: new Map(), attributes: {}, markets: new Map([["1", usd(25_000)]]), block: BLOCK };
    const [it0] = buildAuctionItems({ ...base, pools: [{ cardId: 1n, shardToken: shardings[0]!.shardToken, priceUsdcPerShard: usd(1875), frozen: false }] });
    expect(it0).toMatchObject({ clearing: usd(1712), poolPrice: usd(1875) });
    expect(it0!.premium).toBeCloseTo(0.2, 3);
    const [frozen] = buildAuctionItems({ ...base, pools: [{ cardId: 1n, shardToken: shardings[0]!.shardToken, priceUsdcPerShard: usd(1875), frozen: true }] });
    expect(frozen!.poolPrice).toBeNull();
    const [none] = buildAuctionItems(base);
    expect(none!.poolPrice).toBeNull();
  });

  it("puts live rows in Live, the last 300 blocks in Ending soon, never anything in Upcoming", () => {
    const items = fixture();
    expect(items.filter((i) => inTab(i, "live", BLOCK)).map((i) => i.cardId)).toEqual([1n, 2n]);
    expect(items.filter((i) => inTab(i, "soon", BLOCK)).map((i) => i.cardId)).toEqual([2n]);
    expect(items.filter((i) => inTab(i, "upcoming", BLOCK))).toEqual([]);
    expect(items.filter((i) => inTab(i, "ended", BLOCK)).map((i) => i.cardId)).toEqual([3n, 5n, 4n]);
    expect(elapsed(items[0]!, BLOCK)).toBe(0.5);
  });

  it("searches name, set, ENS name and language", () => {
    const [lotus, recall] = fixture();
    expect(matchesSearch(lotus!, "black lotus")).toBe(true);
    expect(matchesSearch(lotus!, "lea")).toBe(true);
    expect(matchesSearch(lotus!, "card-1.kura")).toBe(true);
    expect(matchesSearch(lotus!, "black lotus japanese")).toBe(false);
    expect(matchesSearch(recall!, "recall japanese")).toBe(true);
  });

  it("ignores accents and case on both sides", () => {
    const [lotus] = fixture();
    const vault = { ...lotus!, name: "Lim-Dûl's Vault" };
    expect(matchesSearch(vault, "lim-dul")).toBe(true);
    expect(matchesSearch(vault, "LIM-DÛL")).toBe(true);
    expect(matchesSearch({ ...lotus!, name: "Jötun Grunt" }, "jotun")).toBe(true);
    expect(fold("Éowyn")).toBe("eowyn");
    // Kana voicing marks are letters' identity, not accents.
    expect(fold("ガ")).not.toBe(fold("カ"));
    expect(fold("ガ")).toBe("ガ");
  });

  it("writes short ages", () => {
    expect([10, 120, 5 * 3600, 26 * 3600, 3 * 86_400].map((s) => shortAgo(1_000_000 - s, 1_000_000))).toEqual(["just now", "2m ago", "5h ago", "yesterday", "3d ago"]);
  });

  it("filters by set, condition, language, vs market and price, and sorts", () => {
    const items = fixture();
    const f = (p: Partial<ExploreFilters>) => exploreResults(items, { ...DEFAULT_FILTERS, ...p }, BLOCK).map((i) => i.cardId);
    expect(f({})).toEqual([2n, 1n]); // ending soonest
    expect(f({ sort: "price-desc" })).toEqual([1n, 2n]);
    expect(f({ set: ["LEA"] })).toEqual([1n]);
    expect(f({ cond: ["LP"] })).toEqual([2n]);
    expect(f({ lang: ["ja"] })).toEqual([2n]);
    expect(f({ vs: ["below"] })).toEqual([2n]);
    expect(f({ vs: ["above"] })).toEqual([1n]);
    expect(f({ pmin: 1000 })).toEqual([1n]);
    expect(f({ color: ["C"] })).toEqual([1n]);
    expect(f({ ends: ["1h"] })).toEqual([2n]);
    expect(vsBand(0.04)).toBe("at");
  });

  it("round-trips filters through the query string", () => {
    const f: ExploreFilters = { ...DEFAULT_FILTERS, q: "lotus", tab: "ended", set: ["LEA", "LEB"], cond: ["NM"], pmin: 10, pmax: 2000, vs: ["below"] };
    const q = filtersToQuery(f);
    expect(parseFilters(new URLSearchParams(q))).toEqual(f);
    expect(filtersToQuery(DEFAULT_FILTERS)).toBe("");
    expect(activeFilterCount(f)).toBe(4);
    expect(parseFilters(new URLSearchParams("tab=bogus&cond=zz&vs=nope"))).toEqual(DEFAULT_FILTERS);
  });
});
