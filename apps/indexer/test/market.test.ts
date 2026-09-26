import { describe, expect, it } from "vitest";
import { usdcPerShardToQ96 } from "../src/lib/math";
import { usdcPerShardFromSqrtPrice, executionPrice } from "../src/lib/market-math";
import { isPoolHolder, marketEnabled, poolOpenedActivity, seededPoolRow, swapActivity, swapFromDeltas, swapPoolPatch, swapSummary } from "../src/lib/market";

const Q96 = 2n ** 96n;
const SHARD = 10n ** 18n;
const USDC = 10n ** 6n;
const ALICE = "0x00000000000000000000000000000000000000a1";
const POOL_MANAGER = "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543";
const POOL_ID = `0x${"11".repeat(32)}` as const;
const SHARD_TOKEN = "0x0000000000000000000000000000000000000011";

const isqrt = (n: bigint) => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
};
// Task A2's formula: USDC is currency1 -> sqrt(clearingPriceQ96 * 2^96); USDC is currency0 -> the inverse price.
const sqrtAt = (usdcPerShard: bigint, shardIsCurrency0: boolean) => {
  const q = usdcPerShardToQ96(usdcPerShard);
  return shardIsCurrency0 ? isqrt(q * Q96) : isqrt((Q96 * Q96 * Q96) / q);
};

describe("usdcPerShardFromSqrtPrice", () => {
  for (const shardIsCurrency0 of [true, false]) {
    it(`reads $10 per whole shard back when the shard is currency${shardIsCurrency0 ? 0 : 1}`, () => {
      const p = usdcPerShardFromSqrtPrice(sqrtAt(10n * USDC, shardIsCurrency0), shardIsCurrency0);
      expect(p >= 10n * USDC - 1n && p <= 10n * USDC + 1n).toBe(true);
    });
    it(`reads $0.25 and $4,000 in the currency${shardIsCurrency0 ? 0 : 1} order`, () => {
      for (const want of [250_000n, 4_000n * USDC]) {
        const p = usdcPerShardFromSqrtPrice(sqrtAt(want, shardIsCurrency0), shardIsCurrency0);
        expect(p >= want - 1n && p <= want + 1n).toBe(true);
      }
    });
  }
  it("returns 0 for an uninitialised price instead of dividing by zero", () => {
    expect(usdcPerShardFromSqrtPrice(0n, false)).toBe(0n);
    expect(usdcPerShardFromSqrtPrice(0n, true)).toBe(0n);
  });
});

describe("executionPrice", () => {
  it("is USDC per whole shard, 6 dp", () => {
    expect(executionPrice(41_100_000n * 32n / 10n, 32n * SHARD / 10n)).toBe(41_100_000n);
  });
  it("is 0 for a zero-shard swap", () => {
    expect(executionPrice(5n, 0n)).toBe(0n);
  });
});

describe("swapFromDeltas", () => {
  it("maps a positive shard delta to a buy", () => {
    expect(swapFromDeltas(3n * SHARD, -30n * USDC)).toEqual({ side: "buy", shardAmount: 3n * SHARD, usdcAmount: 30n * USDC, priceUsdcPerShard: 10n * USDC });
  });
  it("maps a negative shard delta to a sell", () => {
    expect(swapFromDeltas(-2n * SHARD, 19n * USDC)).toEqual({ side: "sell", shardAmount: 2n * SHARD, usdcAmount: 19n * USDC, priceUsdcPerShard: 9_500_000n });
  });
});

describe("swapSummary", () => {
  it("reads like the other activity rows", () => {
    expect(swapSummary({ side: "buy", shardAmount: 32n * SHARD / 10n, priceUsdcPerShard: 41_100_000n })).toBe("bought 3.2 shards at $41.10");
    expect(swapSummary({ side: "sell", shardAmount: SHARD, priceUsdcPerShard: 12n * USDC })).toBe("sold 1 shard at $12.00");
    expect(swapSummary({ side: "buy", shardAmount: 1_234_567_000_000_000n, priceUsdcPerShard: 1_234_567n })).toBe("bought 0.0012 shards at $1.23");
    expect(swapSummary({ side: "sell", shardAmount: 1_500n * SHARD, priceUsdcPerShard: 1_250_000_000n })).toBe("sold 1,500 shards at $1,250.00");
  });
});

describe("swapActivity", () => {
  it("credits the trader with the USDC leg and keeps the shard side in meta", () => {
    const s = swapFromDeltas(32n * SHARD / 10n, -131_520_000n);
    expect(swapActivity({ trader: ALICE, poolId: POOL_ID, ...s, sqrtPriceX96: 7n })).toEqual({
      kind: "swap",
      actor: ALICE,
      amount: 131_520_000n,
      meta: {
        side: "buy",
        shardAmount: (32n * SHARD / 10n).toString(),
        usdcAmount: "131520000",
        priceUsdcPerShard: "41100000",
        sqrtPriceX96: "7",
        poolId: POOL_ID,
        summary: "bought 3.2 shards at $41.10",
      },
    });
  });
});

describe("seeded pool and pool_opened activity", () => {
  const seed = { cardId: 3n, poolId: POOL_ID, shardToken: SHARD_TOKEN, sqrtPriceX96: sqrtAt(10n * USDC, true), shardIsCurrency0: true, shardAmount: 60n * SHARD, usdcAmount: 400n * USDC } as const;
  it("opens a pool row at the seed price with zeroed counters", () => {
    const row = seededPoolRow({ ...seed, lpOwner: ALICE, timestamp: 1_700_000_000n });
    expect(row).toMatchObject({
      cardId: 3n, poolId: POOL_ID, shardToken: SHARD_TOKEN, shardIsCurrency0: true, sqrtPriceX96: seed.sqrtPriceX96,
      seededAt: 1_700_000_000n, seedShards: 60n * SHARD, seedUsdc: 400n * USDC, lastSwapAt: null, swapCount: 0, volumeUsdc: 0n,
      frozen: false, lpOwner: ALICE, feesShards: 0n, feesUsdc: 0n,
    });
    expect(row.priceUsdcPerShard >= 10n * USDC - 1n && row.priceUsdcPerShard <= 10n * USDC + 1n).toBe(true);
  });
  it("records a pool_opened activity for the LP owner with the opening price", () => {
    const a = poolOpenedActivity({ lpOwner: ALICE, poolId: POOL_ID, shardToken: SHARD_TOKEN, priceUsdcPerShard: 10n * USDC, shardAmount: 60n * SHARD, usdcAmount: 400n * USDC });
    expect(a).toEqual({
      kind: "pool_opened",
      actor: ALICE,
      amount: 10n * USDC,
      meta: { poolId: POOL_ID, shardToken: SHARD_TOKEN, priceUsdcPerShard: "10000000", seedShards: (60n * SHARD).toString(), seedUsdc: "400000000" },
    });
  });
});

describe("swapPoolPatch", () => {
  it("moves the price to the post-swap sqrt price and adds to count and volume", () => {
    const pool = { shardIsCurrency0: false, swapCount: 2, volumeUsdc: 50n * USDC };
    const sqrt = sqrtAt(12n * USDC, false);
    const p = swapPoolPatch(pool, { sqrtPriceX96: sqrt, usdcAmount: 7n * USDC, timestamp: 99n });
    expect(p).toMatchObject({ sqrtPriceX96: sqrt, lastSwapAt: 99n, swapCount: 3, volumeUsdc: 57n * USDC });
    expect(p.priceUsdcPerShard >= 12n * USDC - 1n && p.priceUsdcPerShard <= 12n * USDC + 1n).toBe(true);
  });
});

describe("pool-less cards and holders", () => {
  it("tags only the v4 PoolManager as the pool holder, case-insensitively", () => {
    expect(isPoolHolder(POOL_MANAGER.toLowerCase(), POOL_MANAGER)).toBe(true);
    expect(isPoolHolder(ALICE, POOL_MANAGER)).toBe(false);
  });
  it("never tags a holder as the pool when no PoolManager is configured", () => {
    expect(isPoolHolder("0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000")).toBe(false);
  });
  it("skips the market on a deployment without ShardMarket", () => {
    expect(marketEnabled("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(marketEnabled("0x00000000000000000000000000000000000000c0")).toBe(true);
  });
});
