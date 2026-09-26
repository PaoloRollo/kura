import { describe, expect, it } from "vitest";
import { usdcPerShardToQ96 } from "@kura/shared";
import { analyticsView, mintedSub, parseRange, rangeWindow, withMultibaas, type AnalyticsCard, type AnalyticsInput } from "@/lib/analytics-view";
import type { MultibaasFigures } from "@/lib/multibaas/figures";

const H = 3600;
const D = 86_400;
const now = Date.UTC(2026, 8, 26, 14, 37) / 1000; // Sat 2026-09-26 14:37 UTC
const usd = (d: number) => BigInt(Math.round(d * 1e6));
const hex = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;

const card = (id: number, state: AnalyticsCard["state"], extra: Partial<AnalyticsCard> = {}): AnalyticsCard => ({
  id: BigInt(id), state, shardToken: state === "sharded" || state === "auctioning" ? hex(0x5000 + id) : null, scryfallId: `s${id}`,
  language: "en", label: `card-${id}`, ensName: `card-${id}.kura.eth`, mintedAt: now - 30 * D, ...extra,
});
const sharding = (id: number, graduated: boolean | null, clearing: number | null, totalShards = 16) => ({
  shardToken: hex(0x5000 + id), cardId: BigInt(id), auction: hex(0xa000 + id), totalShards, graduated,
  clearingPriceQ96: clearing == null ? null : usdcPerShardToQ96(usd(clearing)), createdAt: now - 20 * D,
});

function input(over: Partial<AnalyticsInput> = {}): AnalyticsInput {
  return {
    cards: [
      card(1, "sharded"), // graduated: 16 × 1712 = 27,392 vs 25,000 → +9.6%
      card(2, "sharded", { language: "ja" }), // reserve not met → n/a
      card(3, "auctioning"), // live: latest checkpoint 40 × 16 = 640 vs 620.8 → +3.1%
      card(4, "whole", { language: "ja", mintedAt: now - H }),
      card(5, "released"),
      card(6, "sharded"), // no market price: in the map, n/a premium, not ranked
    ],
    shardings: [sharding(1, true, 1712), sharding(2, false, 90), sharding(3, null, null), sharding(6, true, 100)],
    active: [{ auction: hex(0xa003), endBlock: 1_021n }, { auction: hex(0xa009), endBlock: 1_000n }],
    checkpoints: [
      { auction: hex(0xa003), blockNumber: 990n, clearingPriceQ96: usdcPerShardToQ96(usd(40)) },
      { auction: hex(0xa003), blockNumber: 900n, clearingPriceQ96: usdcPerShardToQ96(usd(30)) },
    ],
    activities: [
      { kind: "settle", amount: usd(5136), actor: "0x1", timestamp: now - 2 * D, meta: { graduated: true } },
      { kind: "settle", amount: usd(900), actor: "0x1", timestamp: now - 2 * D, meta: { graduated: false } },
      { kind: "redeem", amount: usd(1000), actor: "0x2", timestamp: now - 3 * H, meta: null },
      { kind: "settle", amount: usd(7000), actor: "0x1", timestamp: now - 10 * D, meta: { graduated: true } },
    ],
    fees: [{ amountUsdc: usd(128.4), timestamp: now - 2 * D }, { amountUsdc: usd(50), timestamp: now - 10 * D }],
    collectors: 58,
    markets: new Map<string, bigint | null>([["1", usd(25_000)], ["2", usd(900)], ["3", usd(620.8)], ["6", null]]),
    attributes: { s1: { name: "Black Lotus", image: "/cards/black-lotus.webp" } },
    block: 1_000n,
    now,
    range: "7d",
    ...over,
  };
}

describe("analytics view", () => {
  it("excludes a non-graduated card from Richest premiums and gives it a neutral n/a tile sized by the market", () => {
    const v = analyticsView(input());
    expect(v.premiums.map((r) => r.label)).toEqual(["Black Lotus", "card-3"]);
    expect(v.premiums[0]).toMatchObject({ rank: 1, value: "+9.6%", tone: "pos", href: "/app/cards/1?tab=analytics", thumb: "/cards/black-lotus.webp" });
    expect(v.premiums[1]).toMatchObject({ value: "+3.1%", tone: "pos", live: true });
    expect(v.premiums[0]!.live).toBe(false);
    // The live auction's tile says so; the settled ones and the n/a one don't.
    expect(v.treemap.filter((i) => i.live).map((i) => i.id)).toEqual(["3"]);
    const na = v.treemap.find((i) => i.id === "2")!;
    expect(na).toMatchObject({ premium: null, value: 900, sizedByMarket: true, href: "/app/cards/2?tab=analytics" });
    // No market price: still mapped at its implied value, premium n/a.
    expect(v.treemap.find((i) => i.id === "6")).toMatchObject({ value: 1600, premium: null, sizedByMarket: false });
    // Whole and released cards are not in the map.
    expect(v.treemap.map((i) => i.id).sort()).toEqual(["1", "2", "3", "6"]);
  });

  it("leaves a card out of the map when it has neither an implied value nor a market price", () => {
    const v = analyticsView(input({ markets: new Map([["1", usd(25_000)]]) }));
    expect(v.treemap.find((i) => i.id === "2")).toBeUndefined();
  });

  it("sums Value locked over implied values only (the non-graduated card adds nothing)", () => {
    const t = analyticsView(input()).tiles;
    expect(t.valueLocked).toBe(usd(27_392 + 1600 + 640));
    expect(t.cardsInVault).toBe(5);
    expect(t.collectors).toBe(58);
  });

  it("counts live auctions by endBlock > block, ignoring ended-unsettled rows", () => {
    const t = analyticsView(input()).tiles;
    expect(t.liveAuctions).toBe(1);
    expect(t.nextEndsIn).toBe(21n);
    expect(analyticsView(input({ block: 1_021n })).tiles).toMatchObject({ liveAuctions: 0, nextEndsIn: null });
  });

  it("filters raised, fees and mints by the range; graduated settles only", () => {
    const week = analyticsView(input()).tiles;
    expect(week).toMatchObject({ raised: usd(5136), raisedAuctions: 1, fees: usd(128.4), mintedInRange: 1 });
    const all = analyticsView(input({ range: "all" })).tiles;
    expect(all).toMatchObject({ raised: usd(12_136), raisedAuctions: 2, fees: usd(178.4), mintedInRange: 5 });
    const day = analyticsView(input({ range: "24h" })).tiles;
    expect(day).toMatchObject({ raised: 0n, fees: 0n, mintedInRange: 1 });
  });

  it("yields exactly 24 hourly buckets for 24h and 7 daily for 7d, volume = settle + redeem", () => {
    const day = analyticsView(input({ range: "24h" }));
    expect(day.volume).toHaveLength(24);
    expect(day.volume.at(-1)!.date).toBe("2026-09-26T14");
    expect(day.volume[0]!.date).toBe("2026-09-25T15");
    expect(day.volume.reduce((a, p) => a + p.value, 0)).toBe(1000);
    const week = analyticsView(input());
    expect(week.volume).toHaveLength(7);
    expect(week.volume.map((p) => p.date)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"]);
    expect(week.volume.find((p) => p.date === "2026-09-24")!.value).toBe(5136);
    expect(week.volume.at(-1)!.value).toBe(1000);
  });

  it("keeps quiet 24h buckets at zero rather than missing", () => {
    const v = analyticsView(input({ range: "24h", activities: [] }));
    expect(v.volume).toHaveLength(24);
    expect(v.volume.every((p) => p.value === 0)).toBe(true);
  });

  it("runs All from the earliest activity or mint day", () => {
    const v = analyticsView(input({ range: "all" }));
    expect(v.volume[0]!.date).toBe("2026-08-27"); // the mints, 30 days back
    expect(rangeWindow("all", now, null)).toEqual({ from: Date.UTC(2026, 8, 26) / 1000, to: now, unit: "day" });
  });

  it("groups the vault by language, released cards excluded", () => {
    expect(analyticsView(input()).languages).toEqual([{ label: "English", count: 3 }, { label: "Japanese", count: 2 }]);
  });

  it("is empty with zero tiles when nothing is in the vault", () => {
    const v = analyticsView(input({ cards: [card(5, "released")], shardings: [], active: [], checkpoints: [], activities: [], fees: [], collectors: 0 }));
    expect(v.empty).toBe(true);
    expect(v.tiles).toMatchObject({ cardsInVault: 0, valueLocked: 0n, raised: 0n, fees: 0n, liveAuctions: 0, collectors: 0 });
    expect(v.treemap).toEqual([]);
  });

  it("parses the range and words the mint delta", () => {
    expect(parseRange("24h")).toBe("24h");
    expect(parseRange("all")).toBe("all");
    expect(parseRange("nope")).toBe("7d");
    expect(parseRange(null)).toBe("7d");
    expect(mintedSub("7d", 4)).toBe("+4 this week");
    expect(mintedSub("24h", 1)).toBe("+1 in 24h");
    expect(mintedSub("all", 23)).toBe("23 minted");
  });
});

const figures = (over: Partial<MultibaasFigures> = {}): MultibaasFigures => ({
  range: "24h", window: { from: now - 23 * H, to: now, unit: "hour" }, raised: usd(9999), raisedAuctions: 3, fees: usd(250),
  mintedInRange: 5, totalMints: 6, volume: [{ date: "2026-09-26T14", volumeUsdc: usd(42) }], ...over,
});

describe("withMultibaas", () => {
  it("takes raised, fees, mints and volume from MultiBaas for 24h and keeps the indexer's live state", () => {
    const base = analyticsView(input({ range: "24h" }));
    const v = withMultibaas(base, figures(), "24h");
    expect(v.source).toBe("multibaas");
    expect(v.window).toEqual(figures().window);
    expect(v.tiles).toEqual({ ...base.tiles, raised: usd(9999), raisedAuctions: 3, fees: usd(250), mintedInRange: 5 });
    expect(v.volume).toEqual([{ date: "2026-09-26T14", value: 42 }]);
    expect(v.treemap).toBe(base.treemap);
    expect(v.premiums).toBe(base.premiums);
  });

  it("keeps the indexer's figures without MultiBaas, for 7d and All, and for another range's figures", () => {
    const base = analyticsView(input());
    expect(base.source).toBe("indexer");
    expect(withMultibaas(base, null, "24h")).toBe(base);
    expect(withMultibaas(base, figures({ range: "7d" }), "7d")).toBe(base);
    expect(withMultibaas(base, figures({ range: "all" }), "all")).toBe(base);
    expect(withMultibaas(base, figures(), "7d")).toBe(base);
  });

  it("reads a quiet day as a quiet day: MultiBaas holds no mint from before its link", () => {
    const base = analyticsView(input({ range: "24h" }));
    const v = withMultibaas(base, figures({ totalMints: 0, mintedInRange: 0, raised: 0n, raisedAuctions: 0, fees: 0n }), "24h");
    expect(v.source).toBe("multibaas");
    expect(v.tiles).toMatchObject({ raised: 0n, fees: 0n, mintedInRange: 0, cardsInVault: base.tiles.cardsInVault });
  });
});
