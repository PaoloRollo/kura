import { describe, expect, it } from "vitest";
import { usdcPerShardToQ96 } from "@kura/shared";
import { bucketSeries, clearingLevel, dailySeries, demandCurve, holderSeries } from "@/lib/series";

const day = 86_400;
const t0 = Date.UTC(2026, 8, 25) / 1000; // 2026-09-25T00:00Z

describe("series", () => {
  it("buckets volume (settle + redeem only) by UTC day and fills empty days", () => {
    const rows = [
      { kind: "settle", amount: 10_000_000n, actor: "0x1", timestamp: t0 + 100, meta: { graduated: true } },
      { kind: "bid", amount: 99_000_000n, actor: "0x1", timestamp: t0 + 50 },
      { kind: "mint", amount: null, actor: "0x2", timestamp: t0 + 200 },
      { kind: "redeem", amount: 30_000_000n, actor: "0x1", timestamp: t0 + 2 * day + 5 },
      { kind: "payout", amount: 30_000_000n, actor: "0x1", timestamp: t0 + 2 * day + 5 },
      { kind: "named", amount: null, actor: "0x3", timestamp: t0 + 2 * day + 6, meta: { handle: true } },
      { kind: "named", amount: null, actor: "0x4", timestamp: t0 + 2 * day + 7, meta: { label: "card" } },
    ];
    const s = dailySeries(rows, new Date(t0 * 1000), new Date((t0 + 2 * day) * 1000));
    expect(s.map((d) => d.date)).toEqual(["2026-09-25", "2026-09-26", "2026-09-27"]);
    expect(s[0]).toMatchObject({ volumeUsdc: 10_000_000n, mints: 1, newCollectors: 0 });
    expect(s[1]).toMatchObject({ volumeUsdc: 0n, mints: 0, newCollectors: 0 });
    expect(s[2]).toMatchObject({ volumeUsdc: 30_000_000n, mints: 0, newCollectors: 1 });
  });

  it("buckets by UTC hour for 24h", () => {
    const rows = [{ kind: "redeem", amount: 5n, actor: "0x1", timestamp: t0 + 3 * 3600 + 10 }];
    const s = bucketSeries(rows, new Date(t0 * 1000), new Date((t0 + 23 * 3600 + 59) * 1000), "hour");
    expect(s).toHaveLength(24);
    expect(s[0]!.date).toBe("2026-09-25T00");
    expect(s[3]).toMatchObject({ date: "2026-09-25T03", volumeUsdc: 5n });
  });

  it("counts holders per block from transfers, in block and log order", () => {
    const transfers = [
      { id: "0xt2-0", from: "0xa", to: "0xb", amount: 2n, blockNumber: 2n, timestamp: 2 },
      { id: "0xt1-0", from: "0x0000000000000000000000000000000000000000", to: "0xa", amount: 5n, blockNumber: 1n, timestamp: 1 },
      { id: "0xt3-1", from: "0xb", to: "0xc", amount: 2n, blockNumber: 3n, timestamp: 3 },
    ];
    expect(holderSeries(transfers, []).map((p) => p.holders)).toEqual([1, 2, 2]);
    // Same block: one point, the last state. Log 3 moves the auction's shards to 0xd; the auction is excluded.
    const same = [
      { id: "0xt-3", from: "0xauc", to: "0xd", amount: 1n, blockNumber: 5n, timestamp: 5 },
      { id: "0xt-1", from: "0x0000000000000000000000000000000000000000", to: "0xauc", amount: 1n, blockNumber: 5n, timestamp: 5 },
    ];
    expect(holderSeries(same, ["0xAUC"])).toEqual([{ blockNumber: 5n, timestamp: 5, holders: 1 }]);
  });

  it("builds a cumulative demand curve by descending price level", () => {
    const q = (usdc: bigint) => usdcPerShardToQ96(usdc);
    const bids = [
      { maxPriceQ96: q(10_000_000n), amountUsdc: 5n },
      { maxPriceQ96: q(30_000_000n), amountUsdc: 1n },
      { maxPriceQ96: q(20_000_000n), amountUsdc: 2n },
      { maxPriceQ96: q(10_000_000n), amountUsdc: 4n },
    ];
    const c = demandCurve(bids);
    expect(c.map((p) => p.maxUsdcPerShard)).toEqual([30_000_000n, 20_000_000n, 10_000_000n]);
    expect(c.map((p) => p.levelUsdc)).toEqual([1n, 2n, 9n]);
    expect(c.map((p) => p.cumulativeUsdc)).toEqual([1n, 3n, 12n]);
    // The lowest level still in the money: max price at or above the clearing.
    expect(clearingLevel(c, 25_000_000n)).toBe(0);
    expect(clearingLevel(c, 20_000_000n)).toBe(1);
    expect(clearingLevel(c, 5_000_000n)).toBe(2);
    expect(clearingLevel(c, 35_000_000n)).toBe(-1);
    expect(clearingLevel(c, null)).toBe(-1);
  });
});
