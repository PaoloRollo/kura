import { describe, expect, it } from "vitest";
import { usdcPerShardToQ96 } from "@kura/shared";
import { allocation, bidItems, historyRows, holdings, payouts, shortLeft, totals, wholeCards } from "@/lib/portfolio";

const S = 10n ** 18n;
const usd = (d: number) => BigInt(Math.round(d * 100)) * 10_000n;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const ME = addr(0xabc);
const OTHER = addr(0xdef);
const VAULT = addr(0x777);
const BLOCK = 1_000n;
const ident = (id: bigint) => ({ name: `Card ${id}`, image: null });

function sharding(n: number, p: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(n), ...p };
}
function base(n: number) {
  return {
    shardToken: addr(0x100 + n), cardId: BigInt(n), auction: addr(0x200 + n), totalShards: 16, forSale: 3,
    floorPriceQ96: usdcPerShardToQ96(usd(1560)), startBlock: 0n, endBlock: 900n, settled: true, graduated: true as boolean | null,
    clearingPriceQ96: usdcPerShardToQ96(usd(1712)) as bigint | null, clearingUsdcPerShard: usd(1712) as bigint | null,
    buyoutPerShard: null as bigint | null, redeemer: null as `0x${string}` | null, feeUsdc: usd(128.4) as bigint | null,
  };
}
const bid = (n: number, p: Partial<Parameters<typeof bidItems>[0]["bids"][number]> = {}) => ({
  id: `b${n}`, auction: addr(0x200 + n), bidId: BigInt(n), cardId: BigInt(n), owner: ME, maxPriceQ96: usdcPerShardToQ96(usd(1760)), amountUsdc: usd(2568),
  submittedBlock: 10n, submittedAt: 10 + n, status: "claimed" as const, tokensFilled: 15n * S / 10n, currencyRefunded: 0n, ...p,
});

describe("holdings", () => {
  const shardings = [
    sharding(1), // I sharded this one and kept 13
    sharding(2), // I bought 1.5 at $1,712
    sharding(3, { settled: false, graduated: null, clearingUsdcPerShard: usd(662), endBlock: 1_060n }), // live
    sharding(4, { redeemer: OTHER, buyoutPerShard: usd(1840) }), // bought out: a payout, not a holding
  ];
  const balances = [
    { shardToken: shardings[0]!.shardToken, holder: ME, balance: 13n * S },
    { shardToken: shardings[1]!.shardToken, holder: ME, balance: 15n * S / 10n },
    { shardToken: shardings[2]!.shardToken, holder: ME, balance: 5n * S / 2n },
    { shardToken: shardings[3]!.shardToken, holder: ME, balance: S },
    { shardToken: shardings[0]!.shardToken, holder: OTHER, balance: 3n * S },
  ];
  const activities = [{ kind: "shard", cardId: 1n, actor: ME, meta: { shardToken: shardings[0]!.shardToken, totalShards: 16, forSale: 3 } }];
  const active = [{ auction: shardings[2]!.auction, endBlock: 1_060n }];
  const bids = [bid(2, { amountUsdc: usd(2550), tokensFilled: 15n * S / 10n })];
  const h = holdings({ me: ME, balances, shardings, cards: [], bids, activities, active, block: BLOCK, ident });

  it("values each holding at its reference price with the right cost", () => {
    expect(h.map((x) => x.cardId)).toEqual([1n, 2n, 3n]);
    const [seller, buyer, live] = h;
    expect(seller).toMatchObject({ seller: true, costKind: "floor", cost: usd(1560), price: usd(1712), value: usd(22_256), gain: usd(1976), redeemable: true, share: 0.8125 });
    expect(buyer).toMatchObject({ costKind: "avg", cost: usd(1700), value: usd(2568), gain: usd(18), redeemable: false });
    expect(live).toMatchObject({ costKind: null, cost: null, gain: null, price: usd(662), liveLeft: 60n });
    expect(shortLeft(60n)).toBe("12m");
  });

  it("sends bought-out shardings to the payout banner", () => {
    expect(payouts(ME, balances, shardings).map((s) => s.cardId)).toEqual([4n]);
  });

  it("totals and allocates over holdings and whole cards", () => {
    const whole = wholeCards(ME, [
      { id: 7n, state: "whole", ownerOf: ME, beneficialOwner: ME, label: "mox", ensName: "mox.kura.eth", condition: "NM", language: "en" },
      { id: 8n, state: "sharded", ownerOf: VAULT, beneficialOwner: ME, label: "x", ensName: "x", condition: "NM", language: "en" },
      { id: 9n, state: "released", ownerOf: ME, beneficialOwner: ME, label: "y", ensName: "y", condition: "NM", language: "en" },
    ], ident, (id) => (id === 7n ? usd(38_400) : null));
    expect(whole.whole.map((w) => w.cardId)).toEqual([7n]);
    expect(whole.released.map((w) => w.cardId)).toEqual([9n]);
    const t = totals(h, whole.whole);
    expect(t.value).toBe(usd(22_256) + usd(2568) + usd(1655) + usd(38_400));
    expect(t.gain).toBe(usd(1994));
    expect(t.cards).toBe(2);
    const a = allocation(h, whole.whole);
    expect(a[0]!.name).toBe("Card 7");
    expect(a.reduce((x, y) => x + y.share, 0)).toBeCloseTo(1, 3);
  });
});

describe("bids", () => {
  it("groups live and ended bids with their line and next step", () => {
    const shardings = [
      sharding(1, { settled: false, graduated: null, endBlock: 2_000n, clearingPriceQ96: usdcPerShardToQ96(usd(1700)), clearingUsdcPerShard: usd(1700) }),
      sharding(2, { settled: false, graduated: null, endBlock: 2_000n, clearingPriceQ96: usdcPerShardToQ96(usd(20)), clearingUsdcPerShard: usd(20) }),
      sharding(3),
      sharding(4),
      sharding(5),
    ];
    const active = [{ auction: shardings[0]!.auction, endBlock: 2_000n }, { auction: shardings[1]!.auction, endBlock: 2_000n }];
    const bids = [
      bid(1, { status: "open", amountUsdc: usd(500), maxPriceQ96: usdcPerShardToQ96(usd(1760)), tokensFilled: null, currencyRefunded: null }),
      bid(2, { status: "open", amountUsdc: usd(60), maxPriceQ96: usdcPerShardToQ96(usd(16)), tokensFilled: null, currencyRefunded: null }),
      bid(3, { status: "open", tokensFilled: null, currencyRefunded: null }),
      bid(4, { status: "exited", tokensFilled: 0n, currencyRefunded: usd(400) }),
      bid(5, { status: "claimed", tokensFilled: 151n * S / 100n }),
      bid(6, { owner: OTHER }),
    ];
    const g = bidItems({ me: ME, bids, shardings, active, block: BLOCK, ident });
    expect(g.live.map((b) => [b.cardId, b.line.text, b.action])).toEqual([
      [2n, "Out · price passed your max", "raise"],
      [1n, "In · would get 0.29 shards", null],
    ]);
    expect(g.ended.map((b) => [b.cardId, b.line.text, b.action])).toEqual([
      [5n, "Filled 1.51 shards", null],
      [4n, "Refunded $400.00", null],
      [3n, "Filled · exit and claim", "claim"],
    ]);
  });
});

describe("history", () => {
  it("lists my activity on the card and my World ID binding, newest first", () => {
    const s = sharding(1);
    const act = (id: string, kind: string, block: bigint, p: Partial<{ actor: `0x${string}`; amount: bigint | null; meta: unknown }> = {}) => ({
      id, kind, cardId: 1n, actor: ME, amount: null, meta: null, blockNumber: block, logIndex: 0, timestamp: Number(block), ...p,
    });
    const rows = historyRows({
      me: ME, cardId: 1n, sharding: s, seller: false, binding: { boundAt: 5, blockNumber: 5n },
      activities: [
        act("c", "claim", 40n, { amount: 15n * S / 10n }),
        act("e", "exit", 30n, { amount: 0n, meta: { auction: s.auction, bidId: "1", tokensFilled: (15n * S / 10n).toString() } }),
        act("b", "bid", 10n, { amount: usd(2568), meta: { auction: s.auction, bidId: "1", maxUsdcPerShard: usd(1760).toString() } }),
        act("o", "bid", 11n, { actor: OTHER, amount: usd(1) }),
        act("x", "settle", 35n, { amount: usd(5136), meta: { graduated: true, shardToken: s.shardToken } }), // I settled someone else's auction
      ],
    });
    expect(rows.map((r) => [r.title, r.detail, r.amount])).toEqual([
      ["Claimed", "1.5 shards to your wallet", null],
      ["Bid won", "1.5 shards at the $1,712 clearing price", -usd(2568)],
      ["Bid placed", "$2,568 up to $1,760 per shard", null],
      ["World ID verified", "one human, one bidding wallet", null],
    ]);
    const seller = historyRows({
      me: ME, cardId: 1n, sharding: s, seller: true, binding: null,
      activities: [
        act("s", "settle", 50n, { actor: OTHER, amount: usd(5136), meta: { graduated: true, shardToken: s.shardToken, clearingUsdcPerShard: usd(1712).toString() } }),
        act("h", "shard", 20n, { meta: { totalShards: 16, forSale: 3, shardToken: s.shardToken } }),
      ],
    });
    expect(seller.map((r) => [r.title, r.detail])).toEqual([
      ["Auction settled", "3 shards sold at $1,712 · fee $128.40"],
      ["Auction opened", "3 of 16 shards"],
      ["Sharded", "kept 13 of 16"],
    ]);
    expect(seller[0]!.amount).toBe(usd(5007.6));
  });
});
