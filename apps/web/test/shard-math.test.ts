import { describe, expect, it } from "vitest";
import { usdcPerShardToQ96 } from "@kura/shared";
import {
  DURATIONS,
  MIN_FLOOR_PRICE_Q96,
  afterFee,
  autoTick,
  defaultPricing,
  durationText,
  floorPriceQ96,
  formatUsdcInput,
  gridColumns,
  parseUsdcInput,
  shardParamErrors,
  validateShardParams,
  type ShardParams,
} from "@/lib/shard-math";

const base: ShardParams = { totalShards: 16, forSale: 3, floorUsdcPerShard: 100n, tickUsdcPerShard: 1n, reserveUsdc: 0n, durationBlocks: 25 };

describe("shard math", () => {
  it("derives a floor and a tick that divides it", () => {
    const p = defaultPricing("160.00", 16);
    expect(p.floorUsdcPerShard % p.tickUsdcPerShard).toBe(0n);
    expect(p.floorUsdcPerShard).toBe(10_000_000n);
    expect(p.tickUsdcPerShard).toBe(100_000n);
  });
  it("matches the design's pricing: $38,400 over 32 shards", () => {
    expect(defaultPricing("38400", 32)).toEqual({ floorUsdcPerShard: 1_200_000_000n, tickUsdcPerShard: 12_000_000n });
  });
  it("never produces a zero tick", () => {
    const p = defaultPricing("0.01", 512);
    expect(p.tickUsdcPerShard).toBeGreaterThanOrEqual(1n);
    expect(p.floorUsdcPerShard).toBeGreaterThanOrEqual(p.tickUsdcPerShard);
  });
  it("keeps a tiny floor above the CCA minimum price", () => {
    const p = defaultPricing("0.01", 512);
    expect(floorPriceQ96(p.floorUsdcPerShard, p.tickUsdcPerShard)).toBeGreaterThanOrEqual(MIN_FLOOR_PRICE_Q96);
    expect(floorPriceQ96(1n, 1n)).toBeGreaterThanOrEqual(MIN_FLOOR_PRICE_Q96);
    expect(validateShardParams({ ...base, totalShards: 512, ...p })).toBeNull();
  });
  it("falls back to 1 USDC and a 0.01 tick without a price", () => {
    expect(defaultPricing(null, 32)).toEqual({ floorUsdcPerShard: 1_000_000n, tickUsdcPerShard: 10_000n });
    expect(defaultPricing("not a number", 32)).toEqual(defaultPricing(null, 32));
  });
  it("builds the floor on a tick, as the vault does", () => {
    const tickQ96 = usdcPerShardToQ96(12_000_000n);
    expect(floorPriceQ96(1_200_000_000n, 12_000_000n)).toBe(tickQ96 * 100n);
    expect(floorPriceQ96(1_200_000_000n, 12_000_000n) % tickQ96).toBe(0n);
  });
  it("validates like the contract", () => {
    expect(validateShardParams({ totalShards: 15, forSale: 1, floorUsdcPerShard: 10n, tickUsdcPerShard: 1n, reserveUsdc: 0n, durationBlocks: 25 })).toMatch(/multiple of 16/);
    expect(validateShardParams({ totalShards: 16, forSale: 17, floorUsdcPerShard: 10n, tickUsdcPerShard: 1n, reserveUsdc: 0n, durationBlocks: 25 })).toMatch(/for sale/);
    expect(validateShardParams({ totalShards: 16, forSale: 3, floorUsdcPerShard: 10n, tickUsdcPerShard: 3n, reserveUsdc: 0n, durationBlocks: 25 })).toMatch(/multiple of the tick/);
    expect(validateShardParams({ totalShards: 16, forSale: 3, floorUsdcPerShard: 10n, tickUsdcPerShard: 1n, reserveUsdc: 0n, durationBlocks: 25 })).toBeNull();
  });
  it("checks the duration range of AuctionSteps.linear", () => {
    expect(validateShardParams({ ...base, durationBlocks: 1 })).toMatch(/too short/);
    expect(validateShardParams({ ...base, durationBlocks: 1_000_001 })).toMatch(/too long/);
    for (const d of DURATIONS) expect(validateShardParams({ ...base, durationBlocks: d.blocks })).toBeNull();
  });
  it("keys errors by field", () => {
    expect(shardParamErrors({ ...base, tickUsdcPerShard: 0n })).toEqual({ tick: expect.stringMatching(/at least/) });
    expect(shardParamErrors({ ...base, floorUsdcPerShard: 101n, tickUsdcPerShard: 2n })).toEqual({ floor: expect.stringMatching(/multiple/) });
  });
  it("uses the four listing lengths, 1 week by default", () => {
    expect(DURATIONS.map((d) => [d.blocks, d.label])).toEqual([[25, "5 min"], [7_200, "1 day"], [50_400, "1 week"], [216_000, "1 month"]]);
    expect(DURATIONS.map((d) => durationText(d.blocks))).toEqual(["5 min", "1 day", "7 days", "30 days"]);
  });
  it("picks a tick that divides a typed floor", () => {
    expect(autoTick(1_200_000_000n)).toBe(12_000_000n);
    expect(autoTick(1_000_001n)).toBe(1n);
    expect(autoTick(1_234_500_000n)).toBe(12_345_000n);
    expect(autoTick(1_234_560_001n)).toBe(1n);
    expect(autoTick(1_234_560_010n)).toBe(10n);
    for (const f of [1n, 99n, 150n, 7_777_777n, 50_000_000n]) expect(f % autoTick(f)).toBe(0n);
  });
  it("parses and formats USDC inputs", () => {
    expect(parseUsdcInput("1,200.00")).toBe(1_200_000_000n);
    expect(parseUsdcInput(".5")).toBe(500_000n);
    expect(parseUsdcInput("1.1234567")).toBeNull();
    expect(parseUsdcInput("abc")).toBeNull();
    expect(parseUsdcInput("")).toBeNull();
    expect(formatUsdcInput(1_200_000_000n)).toBe("1,200.00");
    expect(formatUsdcInput(55n)).toBe("0.000055");
    expect(formatUsdcInput(12_345_678n)).toBe("12.345678");
    expect(formatUsdcInput(0n)).toBe("0.00");
  });
  it("takes the vault fee off the raise", () => {
    expect(afterFee(9_600_000_000n, 250)).toBe(9_360_000_000n);
  });
  it("lays out the shard grid", () => {
    expect(gridColumns(32)).toBe(4);
    expect(gridColumns(16)).toBe(4);
    expect(gridColumns(64)).toBe(8);
    expect(gridColumns(80)).toBeNull();
  });
});

describe("shardRevertMessage", () => {
  it("explains the vault's and the auction's rejections", async () => {
    const { shardRevertMessage } = await import("@/lib/shard-math");
    for (const n of ["NotCardOwner", "WrongState", "InvalidShardCount", "InvalidForSale", "InvalidPricing", "DurationOutOfRange", "FloorPriceTooLow"]) {
      expect(shardRevertMessage(n)?.title).toBeTruthy();
    }
    expect(shardRevertMessage("SomethingElse")).toBeNull();
    expect(shardRevertMessage(null)).toBeNull();
  });
});
