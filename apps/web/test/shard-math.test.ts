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
  marketPrice,
  oneTick,
  roundFloor,
  saleHalf,
  shardOutcome,
  TICK_MISMATCH,
  shardParamErrors,
  validateShardParams,
  type ShardParams,
} from "@/lib/shard-math";

const base: ShardParams = { totalShards: 16, floorUsdcPerShard: 100n, tickUsdcPerShard: 1n, reserveUsdc: 0n, durationBlocks: 25 };

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
    expect(validateShardParams({ totalShards: 15, floorUsdcPerShard: 10n, tickUsdcPerShard: 1n, reserveUsdc: 0n, durationBlocks: 25 })).toMatch(/multiple of 16/);
    expect(validateShardParams({ totalShards: 16, floorUsdcPerShard: 10n, tickUsdcPerShard: 3n, reserveUsdc: 0n, durationBlocks: 25 })).toMatch(/multiple of the tick/);
    expect(validateShardParams({ totalShards: 16, floorUsdcPerShard: 10n, tickUsdcPerShard: 1n, reserveUsdc: 0n, durationBlocks: 25 })).toBeNull();
  });
  it("splits every sharding 50/50: half to the auction, half to the pool", () => {
    expect(saleHalf(16)).toBe(8);
    expect(saleHalf(32)).toBe(16);
    expect(saleHalf(512)).toBe(256);
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
  it("picks a tick that divides a typed floor, never below 0.1% of it", () => {
    expect(autoTick(1_200_000_000n)).toBe(12_000_000n);
    expect(autoTick(1_234_500_000n)).toBe(12_345_000n);
    expect(autoTick(1_250n)).toBe(10n); // 1% (12.5 units) doesn't divide; 10 units does and is >= 0.1%
    expect(autoTick(1_234_567_890n)).toBeNull(); // 10 units divides it, but that's under 0.1%
    expect(autoTick(1_000_001n)).toBeNull(); // only 1 unit divides it, far below 0.1%
    expect(autoTick(1_234_560_010n)).toBeNull();
    expect(autoTick(99n)).toBe(1n);
    for (const f of [1n, 99n, 150n, 50_000_000n, 1_234_500_000n]) {
      const t = autoTick(f)!;
      expect(f % t).toBe(0n);
      expect(t * 1000n >= f).toBe(true);
    }
  });
  it("rounds a floor to the nearest multiple of the tick", () => {
    expect(roundFloor(1_234_567n, 12_346n)).toBe(1_234_600n);
    expect(roundFloor(1_222_000n, 12_346n)).toBe(1_222_254n);
    expect(roundFloor(5n, 12_346n)).toBe(12_346n);
    expect(oneTick(1_234_567n)).toBe(12_346n);
  });
  it("treats a zero market price as no price", () => {
    expect(marketPrice({ adjustedUsd: "0.00" })).toBeNull();
    expect(marketPrice({ adjustedUsd: null })).toBeNull();
    expect(marketPrice(null)).toBeNull();
    expect(marketPrice({ adjustedUsd: "25000" })).toBe(25_000_000_000n);
    expect(defaultPricing("0.00", 32)).toEqual(defaultPricing(null, 32));
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
    for (const n of ["NotCardOwner", "WrongState", "InvalidShardCount", "InvalidPricing", "DurationOutOfRange", "FloorPriceTooLow"]) {
      expect(shardRevertMessage(n)?.title).toBeTruthy();
    }
    expect(shardRevertMessage("SomethingElse")).toBeNull();
    expect(shardRevertMessage(null)).toBeNull();
  });
});

describe("shardOutcome", () => {
  const token = "0x8c0B76235b3c4D179C0576517ae1C66640C8cEBf" as const;
  const auction = "0xdb6E8ADEdfd5dA3A50b9c738755770EDD98E5cCb" as const;
  const hash = "0x3a1f00000000000000000000000000000000000000000000000000000000c9f2" as const;
  const sharded = { id: 1n, shardToken: token, auction, totalShards: 32, forSale: 8, startBlock: 100n, endBlock: 50_500n };
  const card = async () => ({ shardToken: "0x0000000000000000000000000000000000000001" as `0x${string}`, auction: "0x0000000000000000000000000000000000000002" as `0x${string}`, endBlock: 60_000n });

  it("reads the new auction from the receipt's CardSharded", async () => {
    const out = await shardOutcome(hash, { getReceipt: async () => ({ blockNumber: 100n, logs: [] }), readLogs: () => sharded, readCard: card, getBlockNumber: async () => 999n });
    expect(out).toEqual({ shardToken: token, auction, endBlock: 50_500n, refBlock: 100n, hash, source: "receipt" });
  });
  it("falls back to the vault's card record when the step was skipped", async () => {
    const out = await shardOutcome(undefined, { getReceipt: async () => { throw new Error("no hash"); }, readLogs: () => null, readCard: card, getBlockNumber: async () => 999n });
    expect(out).toEqual({ shardToken: "0x0000000000000000000000000000000000000001", auction: "0x0000000000000000000000000000000000000002", endBlock: 60_000n, refBlock: 999n, hash: null, source: "vault" });
  });
  it("falls back to the vault when the receipt has no event, and gives up quietly when everything fails", async () => {
    const out = await shardOutcome(hash, { getReceipt: async () => ({ blockNumber: 100n, logs: [] }), readLogs: () => null, readCard: card, getBlockNumber: async () => 999n });
    expect(out?.source).toBe("vault");
    expect(out?.hash).toBe(hash);
    const fail = async () => { throw new Error("rpc down"); };
    expect(await shardOutcome(hash, { getReceipt: fail, readLogs: () => null, readCard: fail, getBlockNumber: fail })).toBeNull();
  });
});

describe("TICK_MISMATCH", () => {
  it("is the floor error for a floor off the tick", () => {
    expect(shardParamErrors({ ...base, floorUsdcPerShard: 101n, tickUsdcPerShard: 2n }).floor).toBe(TICK_MISMATCH);
  });
});
