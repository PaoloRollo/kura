import { describe, expect, it } from "vitest";
import { usdcPerShardToQ96 } from "@kura/shared";
import {
  ago,
  agoLong,
  blocksToDuration,
  canRedeem,
  currentSharding,
  lastBuyout,
  holdersView,
  orderRecords,
  parseLogId,
  parseTab,
  recordRole,
  setRarity,
  toClaimOf,
} from "@/lib/card-view";

const S = 10n ** 18n;
const TOKEN = "0x00000000000000000000000000000000000005a1" as const;
const AUCTION = "0x000000000000000000000000000000000000a0c7" as const;
const OLD_AUCTION = "0x000000000000000000000000000000000000a0c6" as const;
const VAULT = "0x00000000000000000000000000000000000000fa" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const PAOLO = "0x00000000000000000000000000000000000000aa" as const;
const KENJI = "0x00000000000000000000000000000000000000bb" as const;
const AIKO = "0x00000000000000000000000000000000000000cc" as const;

const sharding = { shardToken: TOKEN, auction: AUCTION, graduated: true as boolean | null, clearingPriceQ96: usdcPerShardToQ96(1_712_000_000n) as bigint | null };
const tr = (id: string, from: `0x${string}`, to: `0x${string}`, block: bigint, timestamp = 100) => ({ id, from, to, shardToken: TOKEN, blockNumber: block, timestamp });

describe("holdersView", () => {
  const balances = [
    { holder: KENJI, balance: 3n * S / 2n },
    { holder: PAOLO, balance: 13n * S },
    { holder: AUCTION, balance: 1n * S },
    { holder: VAULT, balance: S / 2n },
    { holder: AIKO, balance: 0n },
  ];
  const transfers = [
    tr("0xaa-3", ZERO, PAOLO, 10n),
    tr("0xbb-1", AUCTION, KENJI, 20n),
    tr("0xbb-0", OLD_AUCTION, KENJI, 20n),
  ];
  const v = holdersView({ balances, sharding, shardings: [sharding, { ...sharding, auction: OLD_AUCTION }], transfers, vault: VAULT });

  it("keeps the auction and vault in supply but leaves them out of the rows", () => {
    expect(v.supply).toBe(16n * S);
    expect(v.rows.map((r) => r.holder)).toEqual([PAOLO, KENJI]);
    expect(v.unclaimed).toBe(1n * S);
    expect(v.rows[0]!.share).toBeCloseTo(0.8125, 6);
    expect(v.top?.holder).toBe(PAOLO);
  });

  it("colours holders in balance order, values them at clearing and flags redemption at 80%", () => {
    expect(v.rows.map((r) => r.color)).toEqual(["var(--kura-s1)", "var(--kura-s3)"]);
    expect(v.rows[0]!.value).toBe(13n * 1_712_000_000n);
    expect(v.rows[0]!.canRedeem).toBe(true);
    expect(v.rows[1]!.canRedeem).toBe(false);
    // Concentration is over the non-custodian holders (14.5 shards), as lib/metrics defines it.
    expect(v.hhi).toBeCloseTo((13 / 14.5) ** 2 + (1.5 / 14.5) ** 2, 5);
  });

  it("finds where each holder's shards came from (earliest inbound transfer)", () => {
    expect(v.rows[0]!.since).toMatchObject({ kind: "sharded" });
    // Same block: the lower log index is earlier, and any of the card's auctions counts as "auction".
    expect(v.rows[1]!.since).toMatchObject({ kind: "auction", from: OLD_AUCTION });
    const gift = holdersView({ balances: [{ holder: AIKO, balance: S }], sharding, shardings: [sharding], transfers: [tr("0xcc-1", KENJI, AIKO, 30n)], vault: VAULT });
    expect(gift.rows[0]!.since).toMatchObject({ kind: "from", from: KENJI });
  });

  it("marks the Uniswap pool's row: it never redeems and is never the top holder", () => {
    const POOL = "0x000000000000000000000000000000000000900d" as const;
    const pv = holdersView({ balances: [{ holder: POOL, balance: 13n * S, isPool: true }, { holder: KENJI, balance: 3n * S }], sharding, shardings: [sharding], transfers: [], vault: VAULT });
    expect(pv.rows.map((r) => [r.holder, r.isPool, r.canRedeem])).toEqual([[POOL, true, false], [KENJI, false, false]]);
    expect(pv.top?.holder).toBe(KENJI);
  });

  it("shows no value when the auction did not graduate", () => {
    const failed = holdersView({ balances, sharding: { ...sharding, graduated: false }, shardings: [sharding], transfers: [], vault: VAULT });
    expect(failed.clearingPerShard).toBeNull();
    expect(failed.rows[0]!.value).toBeNull();
  });

  it("is empty for a whole card", () => {
    const w = holdersView({ balances: [], sharding: null, shardings: [], transfers: [], vault: VAULT });
    expect(w).toMatchObject({ rows: [], supply: 0n, unclaimed: 0n, hhi: 0, top: null });
  });
});

describe("to claim", () => {
  const Q = (usd: number) => usdcPerShardToQ96(BigInt(usd) * 1_000_000n);
  const clearing = Q(1712);
  const X7A3 = "0x00000000000000000000000000000000000000dd" as const;
  const bid = (owner: `0x${string}`, amountUsd: number, maxUsd: number, status = "open", tokensFilled: bigint | null = null) =>
    ({ auction: AUCTION, owner, maxPriceQ96: Q(maxUsd), amountUsdc: BigInt(amountUsd) * 1_000_000n, status, tokensFilled });

  it("fills a bid above the clearing at the clearing price, uses tokensFilled once exited, and skips claimed and losing bids", () => {
    const won = toClaimOf([
      bid(KENJI, 3424, 1760), // 2 shards at $1,712
      bid(AIKO, 856, 1800, "exited", S / 2n),
      bid(X7A3, 1712, 1800, "claimed", S),
      bid(PAOLO, 1000, 1600), // below the clearing
    ], clearing, 3n * S);
    expect(won).toEqual([{ holder: KENJI, balance: 2n * S }, { holder: AIKO, balance: S / 2n }]);
  });

  it("shares what is left pro rata among bids at the clearing, and never attributes more than the auction holds", () => {
    // 2 shards above the clearing; 1 left for two at-clearing bids wanting 1 and 3 shards: 0.25 and 0.75.
    const won = toClaimOf([bid(KENJI, 3424, 1760), bid(AIKO, 1712, 1712), bid(PAOLO, 5136, 1712)], clearing, 3n * S);
    expect(won).toEqual([{ holder: KENJI, balance: 2n * S }, { holder: PAOLO, balance: 3n * S / 4n }, { holder: AIKO, balance: S / 4n }]);
    // The estimate exceeds the balance (1 shard): scaled down to fit.
    const capped = toClaimOf([bid(KENJI, 3424, 1760)], clearing, S);
    expect(capped).toEqual([{ holder: KENJI, balance: S }]);
  });

  it("splits the auction's balance in holdersView after a graduated auction, the rest unattributed", () => {
    const balances = [{ holder: PAOLO, balance: 13n * S }, { holder: AUCTION, balance: 3n * S }];
    const v = holdersView({ balances, sharding, shardings: [sharding], transfers: [], vault: VAULT, bids: [bid(KENJI, 3424, 1760)] });
    expect(v.toClaim).toMatchObject([{ holder: KENJI, balance: 2n * S, share: 0.125, value: 2n * 1_712_000_000n }]);
    expect(v.unclaimed).toBe(1n * S);
    expect(v.holderCount).toBe(2);
    // Redemption and concentration stay on held balances.
    expect(v.rows.map((r) => r.holder)).toEqual([PAOLO]);
    expect(v.top?.holder).toBe(PAOLO);
  });

  it("keeps every shard 'in auction' while the auction is live, and counts a bidder who also holds once", () => {
    const balances = [{ holder: PAOLO, balance: 13n * S }, { holder: AUCTION, balance: 3n * S }];
    const live = holdersView({ balances, sharding: { ...sharding, graduated: null }, shardings: [sharding], transfers: [], vault: VAULT, bids: [bid(KENJI, 3424, 1760)] });
    expect(live.toClaim).toEqual([]);
    expect(live.unclaimed).toBe(3n * S);
    const both = holdersView({ balances, sharding, shardings: [sharding], transfers: [], vault: VAULT, bids: [bid(PAOLO, 1712, 1800)] });
    expect(both.holderCount).toBe(1);
  });
});

describe("redemption rule", () => {
  it("is balance * 5 >= supply * 4", () => {
    expect(canRedeem(8n, 10n)).toBe(true);
    expect(canRedeem(79n, 100n)).toBe(false);
    expect(canRedeem(0n, 0n)).toBe(false);
  });
});

describe("ENS profile", () => {
  it("derives the writer role from the key", () => {
    expect(recordRole("condition")).toBe("vendor");
    expect(recordRole("grade")).toBe("vendor");
    expect(recordRole("appraisal.usd")).toBe("appraiser");
    expect(recordRole("appraisal.at")).toBe("appraiser");
    expect(recordRole("vault.state")).toBe("vault");
    expect(recordRole("avatar")).toBe("vault");
  });

  it("orders the priority keys first, then the rest alphabetically", () => {
    const keys = ["url", "appraisal.usd", "addr", "vault.state", "condition", "avatar", "language", "vault.clearing_usdc"];
    expect(orderRecords(keys.map((key) => ({ key }))).map((r) => r.key)).toEqual([
      "condition", "language", "vault.state", "vault.clearing_usdc", "appraisal.usd", "addr", "avatar", "url",
    ]);
  });
});

describe("formatting", () => {
  it("ages", () => {
    expect(ago(1000, 1030)).toBe("now");
    expect(ago(1000, 1000 + 120)).toBe("2m");
    expect(ago(0, 3 * 3600)).toBe("3h");
    expect(ago(0, 7 * 86_400)).toBe("7d");
    expect(agoLong(0, 22 * 60)).toBe("22 min ago");
    expect(agoLong(0, 86_400)).toBe("1 day ago");
  });

  it("durations from blocks at 12 s", () => {
    expect(blocksToDuration(50_400n)).toBe("1 week");
    expect(blocksToDuration(21_600n)).toBe("3 days");
    expect(blocksToDuration(300n)).toBe("1 hour");
    expect(blocksToDuration(100n)).toBe("20 min");
  });

  it("set and rarity, log ids and tabs", () => {
    expect(setRarity("lea", "rare")).toBe("LEA · Rare");
    expect(setRarity(undefined, undefined)).toBeNull();
    expect(parseLogId("0xabc-12")).toEqual({ txHash: "0xabc", logIndex: 12 });
    expect(parseTab("holders")).toBe("holders");
    expect(parseTab("nope")).toBe("overview");
    expect(parseTab(null)).toBe("overview");
  });
});

describe("whole again after a buyout", () => {
  const old = { shardToken: TOKEN, auction: AUCTION, graduated: true, clearingPriceQ96: 1n, redeemer: PAOLO, createdAt: 10 };
  const older = { ...old, shardToken: "0x00000000000000000000000000000000000005a0" as const, auction: OLD_AUCTION, redeemer: null, createdAt: 5 };

  it("has no current sharding once the card is whole", () => {
    expect(currentSharding({ state: "whole", shardToken: null }, [old, older])).toBeNull();
    expect(currentSharding(null, [old])).toBeNull();
  });

  it("follows the card's shard token while sharded, else the latest sharding", () => {
    expect(currentSharding({ state: "sharded", shardToken: older.shardToken }, [old, older])).toBe(older);
    expect(currentSharding({ state: "auctioning", shardToken: null }, [old, older])).toBe(old);
  });

  it("finds the buyout that made the card whole, with its redeem activity", () => {
    const redeem = { kind: "redeem" as const, timestamp: 1234, txHash: "0xabc" as const, meta: { shardToken: TOKEN } };
    const b = lastBuyout({ state: "whole" }, [old, older], [{ kind: "bid", timestamp: 1, txHash: "0x1", meta: {} }, redeem]);
    expect(b).toEqual({ sharding: old, redeem });
    expect(lastBuyout({ state: "sharded" }, [old], [redeem])).toBeNull();
    expect(lastBuyout({ state: "whole" }, [], [])).toBeNull();
    // A sharding without a redeemer (e.g. an unsold auction) is not a buyout.
    expect(lastBuyout({ state: "whole" }, [older], [])).toBeNull();
  });
});
