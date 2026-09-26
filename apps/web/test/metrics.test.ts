import { describe, expect, it } from "vitest";
import { usdcPerShardToQ96 } from "@kura/shared";
import { distanceToRedemption, feesByKind, fillRate, hhi, impliedValueUsdc, participation, premium, shares, tokensSold, vendorEarnings } from "@/lib/metrics";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", AUCTION = "0xcccccccccccccccccccccccccccccccccccccccc";
const VAULT = "0xdddddddddddddddddddddddddddddddddddddddd";
const E18 = 10n ** 18n;
const TEN = usdcPerShardToQ96(10_000_000n);

describe("metrics", () => {
  it("implied value is n/a from graduated, not from a null price", () => {
    expect(impliedValueUsdc({ graduated: true, clearingPriceQ96: TEN, totalShards: 16 })).toBe(160_000_000n);
    expect(impliedValueUsdc({ graduated: false, clearingPriceQ96: TEN, totalShards: 16 })).toBeNull();
    expect(impliedValueUsdc({ graduated: null, clearingPriceQ96: null, totalShards: 16 }, TEN)).toBe(160_000_000n);
    expect(impliedValueUsdc({ graduated: null, clearingPriceQ96: null, totalShards: 16 }, null)).toBeNull();
    expect(impliedValueUsdc(null, TEN)).toBeNull();
  });

  it("implied value follows the pool price once a live pool trades the shards", () => {
    expect(impliedValueUsdc({ graduated: true, clearingPriceQ96: TEN, totalShards: 16 }, null, 12_000_000n)).toBe(192_000_000n);
    // No pool, a zero price or a frozen pool (the caller passes null): the clearing again.
    expect(impliedValueUsdc({ graduated: true, clearingPriceQ96: TEN, totalShards: 16 }, null, null)).toBe(160_000_000n);
    expect(impliedValueUsdc({ graduated: true, clearingPriceQ96: TEN, totalShards: 16 }, null, 0n)).toBe(160_000_000n);
  });

  it("premium takes USDC from lib/pricing and handles missing prices", () => {
    expect(premium(160_000_000n, 128_000_000n)).toBeCloseTo(0.25);
    expect(premium(160_000_000n, null)).toBeNull();
    expect(premium(null, 1_000_000n)).toBeNull();
    expect(premium(160_000_000n, 0n)).toBeNull();
  });

  it("shares exclude custodians, and concentration follows", () => {
    const holders = [{ holder: B, balance: 1n * E18 }, { holder: A, balance: 13n * E18 }, { holder: AUCTION, balance: 2n * E18 }];
    const s = shares(holders, [AUCTION]);
    expect(s.map((x) => x.holder)).toEqual([A, B]);
    expect(s[0]!.share).toBeCloseTo(13 / 14);
    expect(hhi(s)).toBeCloseTo((13 / 14) ** 2 + (1 / 14) ** 2);
    expect(shares([], [])).toEqual([]);
  });

  it("distance to redemption uses the full supply, auction included", () => {
    const d = distanceToRedemption(13n * E18, 16n * E18); // A 13, B 1, AUCTION 2
    expect(d).toEqual({ fraction: 0, shardsShort: 0n, eligible: true });
    const d2 = distanceToRedemption(10n * E18, 16n * E18);
    expect(d2.fraction).toBeCloseTo(0.8 - 10 / 16);
    expect(d2.shardsShort).toBe(2_800_000_000_000_000_000n);
    expect(d2.eligible).toBe(false);
    expect(distanceToRedemption(12_800_000_000_000_000_000n, 16n * E18)).toMatchObject({ eligible: true, shardsShort: 0n });
    expect(distanceToRedemption(12_800_000_000_000_000_000n - 1n, 16n * E18)).toMatchObject({ eligible: false, shardsShort: 1n });
  });

  it("tokens sold come from the unsold sweep (auction → vault), or the latest tick while live", () => {
    const settled = { auction: AUCTION, forSale: 3, settled: true, graduated: true };
    const claims = [{ from: AUCTION, to: A, amount: 2n * E18 }];
    expect(tokensSold(settled, [...claims, { from: AUCTION, to: VAULT, amount: E18 }], VAULT)).toBe(2n * E18);
    expect(fillRate(tokensSold(settled, [...claims, { from: AUCTION, to: VAULT, amount: E18 }], VAULT), 3)).toBeCloseTo(2 / 3, 3);
    expect(tokensSold(settled, claims, VAULT)).toBe(3n * E18);
    expect(fillRate(3n * E18, 3)).toBe(1);
    expect(tokensSold(settled, [{ from: AUCTION, to: VAULT, amount: 3n * E18 }], VAULT)).toBe(0n);
    expect(tokensSold({ ...settled, graduated: false }, [{ from: AUCTION, to: VAULT, amount: 3n * E18 }], VAULT)).toBe(0n);
    const live = { ...settled, settled: false, graduated: null };
    expect(tokensSold(live, [], VAULT, { totalCleared: E18 })).toBe(E18);
    expect(tokensSold(live, [], VAULT, null)).toBeNull();
    expect(fillRate(null, 3)).toBeNull();
  });

  it("participation, earnings and fees by kind", () => {
    expect(participation([{ owner: A }, { owner: A.toUpperCase().replace("0X", "0x") }, { owner: B }])).toBe(2);
    const fees = [{ kind: "sale" as const, amountUsdc: 5n }, { kind: "buyout" as const, amountUsdc: 7n }, { kind: "sale" as const, amountUsdc: 1n }];
    expect(vendorEarnings(fees)).toBe(13n);
    expect(feesByKind(fees)).toEqual({ sale: 6n, buyout: 7n, total: 13n });
  });
});
