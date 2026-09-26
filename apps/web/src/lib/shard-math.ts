import { formatUnits, parseUnits, type Address, type Hex, type Log } from "viem";
import { usdcPerShardToQ96 } from "@kura/shared";
import type { Sharded } from "@/lib/vendor";

/**
 * `CardVault.ShardParams`, typed as viem types the ABI tuple: uint16 → number, uint256/uint128 → bigint, and uint40
 * (`durationBlocks`) → number.
 */
export type ShardParams = {
  totalShards: number;
  forSale: number;
  floorUsdcPerShard: bigint;
  tickUsdcPerShard: bigint;
  reserveUsdc: bigint;
  durationBlocks: number;
};

// The vault's limits (CardVault MIN_SHARDS / MAX_SHARDS / SHARD_STEP) and AuctionSteps.linear's duration range.
export const MIN_SHARDS = 16;
export const MAX_SHARDS = 512;
export const SHARD_STEP = 16;
export const MIN_DURATION = 2;
export const MAX_DURATION = 1_000_000;
// The CCA's ConstantsLib: the Q96 floor price must be at least 2^32 + 1 and the Q96 tick spacing at least 2.
export const MIN_FLOOR_PRICE_Q96 = 2n ** 32n + 1n;
export const MIN_TICK_SPACING_Q96 = 2n;
const MAX_UINT128 = 2n ** 128n - 1n;

/** Sepolia's block time, for turning a block count into an end date (an estimate). */
export const BLOCK_SECONDS = 12;

// Sepolia ~12 s blocks. 5 min is for demos; the rest are real listing lengths. Contract max is 1,000,000 blocks.
export const DURATIONS = [
  { blocks: 25, label: "5 min" },
  { blocks: 7_200, label: "1 day" },
  { blocks: 50_400, label: "1 week" },
  { blocks: 216_000, label: "1 month" },
] as const;
export const DEFAULT_DURATION = 50_400;

/** The auction's Q96 floor price, built as the vault does: the Q96 tick times the floor's whole number of ticks. */
export function floorPriceQ96(floorUsdcPerShard: bigint, tickUsdcPerShard: bigint): bigint {
  if (tickUsdcPerShard < 1n) return 0n;
  return usdcPerShardToQ96(tickUsdcPerShard) * (floorUsdcPerShard / tickUsdcPerShard);
}

export function defaultPricing(priceUsd: string | null, totalShards: number): { floorUsdcPerShard: bigint; tickUsdcPerShard: bigint } {
  let market: bigint | null = null;
  try {
    market = priceUsd ? parseUnits(priceUsd, 6) : null;
  } catch {
    market = null;
  }
  const total = market && market > 0n ? market : parseUnits("1", 6) * BigInt(totalShards);
  let floor = total / BigInt(totalShards);
  if (floor < 1n) floor = 1n;
  let tick = (floor + 99n) / 100n; // one percent, rounded up
  if (tick < 1n) tick = 1n;
  floor = (floor / tick) * tick;
  if (floor < tick) floor = tick;
  return { floorUsdcPerShard: floor, tickUsdcPerShard: tick };
}

/** One percent of the floor, rounded up to at least one unit: the tick the designs describe. */
export const oneTick = (floorUsdcPerShard: bigint) => (floorUsdcPerShard + 99n) / 100n || 1n;

/**
 * The tick for a floor the user typed: exactly 1% when it divides the floor, else the largest power of ten at or below
 * 1% that does, as long as it is at least 0.1% of the floor. Null when nothing that coarse divides it: the floor then
 * has to be rounded (`roundFloor`) to the 1% tick.
 */
export function autoTick(floorUsdcPerShard: bigint): bigint | null {
  if (floorUsdcPerShard < 100n) return 1n;
  if (floorUsdcPerShard % 100n === 0n) return floorUsdcPerShard / 100n;
  let tick = 1n;
  while (tick * 10n <= floorUsdcPerShard / 100n) tick *= 10n;
  while (tick > 1n && floorUsdcPerShard % tick !== 0n) tick /= 10n;
  return tick * 1000n >= floorUsdcPerShard ? tick : null;
}

/** The floor moved to the nearest multiple of `tick` (at least one tick). */
export function roundFloor(floorUsdcPerShard: bigint, tickUsdcPerShard: bigint): bigint {
  const n = (floorUsdcPerShard + tickUsdcPerShard / 2n) / tickUsdcPerShard;
  return (n < 1n ? 1n : n) * tickUsdcPerShard;
}

/** A price quote's adjusted market price in USDC, or null when there is none or it is zero. */
export function marketPrice(q: { adjustedUsd: string | null } | null | undefined): bigint | null {
  if (!q?.adjustedUsd) return null;
  try {
    const v = parseUnits(q.adjustedUsd, 6);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export const TICK_MISMATCH = "Floor must be a multiple of the tick";

export type ShardField = "totalShards" | "forSale" | "floor" | "tick" | "reserve" | "duration";

/** Every problem with `p`, keyed by the input it belongs under. Mirrors the vault's, AuctionSteps' and the CCA's checks. */
export function shardParamErrors(p: ShardParams): Partial<Record<ShardField, string>> {
  const e: Partial<Record<ShardField, string>> = {};
  if (p.totalShards < MIN_SHARDS || p.totalShards > MAX_SHARDS || p.totalShards % SHARD_STEP !== 0) {
    e.totalShards = "Shard count must be a multiple of 16 between 16 and 512";
  }
  if (p.forSale < 1 || p.forSale > p.totalShards) e.forSale = "Shards for sale must be between 1 and the shard count";
  if (p.tickUsdcPerShard < 1n) e.tick = "Tick must be at least 0.000001 USDC";
  else if (usdcPerShardToQ96(p.tickUsdcPerShard) < MIN_TICK_SPACING_Q96) e.tick = "Tick is too small";
  if (!e.tick) {
    if (p.floorUsdcPerShard < p.tickUsdcPerShard || p.floorUsdcPerShard % p.tickUsdcPerShard !== 0n) e.floor = TICK_MISMATCH;
    // Unreachable from a tick of 1 unit or more (one USDC unit is ~7.9e10 in Q96), kept as the CCA's own check.
    else if (floorPriceQ96(p.floorUsdcPerShard, p.tickUsdcPerShard) < MIN_FLOOR_PRICE_Q96) e.floor = "Floor is below the auction's minimum price";
  }
  if (p.reserveUsdc < 0n || p.reserveUsdc > MAX_UINT128) e.reserve = "Reserve is out of range";
  if (p.durationBlocks < MIN_DURATION) e.duration = "Duration too short";
  else if (p.durationBlocks > MAX_DURATION) e.duration = "Duration too long";
  return e;
}

const ORDER: ShardField[] = ["totalShards", "forSale", "tick", "floor", "reserve", "duration"];

export function validateShardParams(p: ShardParams): string | null {
  const e = shardParamErrors(p);
  for (const f of ORDER) if (e[f]) return e[f]!;
  return null;
}

/** A USDC amount typed by the user ("1,200.50"): 6-decimal units, or null when it isn't a plain amount. */
export function parseUsdcInput(s: string): bigint | null {
  const v = s.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{0,6})?$|^\.\d{1,6}$/.test(v)) return null;
  return parseUnits(v.startsWith(".") ? `0${v}` : v, 6);
}

/** 6-decimal units as an input value: grouped, at least two decimals ("1,200.00", "0.000055"). */
export function formatUsdcInput(x: bigint): string {
  const [whole, frac = ""] = formatUnits(x, 6).split(".");
  return `${BigInt(whole).toLocaleString("en-US")}.${frac.padEnd(2, "0")}`;
}

/** The proceeds after the vault fee: `raised − raised × feeBps / 10 000` (the vault's settle rounding). */
export function afterFee(raised: bigint, feeBps: number): bigint {
  return raised - (raised * BigInt(feeBps)) / 10_000n;
}

/** A block count as a length of time at ~12 s blocks: "5 min", "1 day", "7 days", "30 days". */
export function durationText(blocks: number): string {
  const s = blocks * BLOCK_SECONDS;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) {
    const h = Math.round(s / 3600);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** When an auction of `blocks` blocks opened at `nowSec` ends, estimated at ~12 s blocks (unix seconds). */
export const estimatedEnd = (nowSec: number, blocks: number) => nowSec + blocks * BLOCK_SECONDS;

/** The shard grid's layout: columns for up to 64 cells (close to square cells on a 63:88 card), else null for bands. */
export function gridColumns(totalShards: number): number | null {
  if (totalShards > 64) return null;
  const target = Math.sqrt((totalShards * 63) / 88);
  let best = 1;
  for (let c = 1; c <= totalShards; c++) {
    if (totalShards % c === 0 && Math.abs(c - target) < Math.abs(best - target)) best = c;
  }
  return best;
}

/**
 * The failure card's copy for a `shardAndAuction` revert that retrying won't fix (the settings or the card's state must
 * change first), by decoded error name; null for anything else.
 */
export function shardRevertMessage(name: string | null | undefined): { title: string; body: string } | null {
  switch (name) {
    case "NotCardOwner":
      return { title: "This wallet doesn't own the card", body: "Only the card's owner can shard it. Nothing was sent or charged." };
    case "WrongState":
      return { title: "This card can't be sharded now", body: "It's no longer a whole card in the vault. Nothing was sent or charged." };
    case "InvalidShardCount":
      return { title: "That shard count isn't allowed", body: "Pick a multiple of 16 between 16 and 512." };
    case "InvalidForSale":
      return { title: "That many shards can't go up for sale", body: "Sell at least one shard and no more than the total." };
    case "InvalidPricing":
    case "FloorPriceTooLow":
    case "FloorPriceIsZero":
    case "TickSpacingTooSmall":
    case "TickPriceNotAtBoundary":
    case "FloorPriceAndTickSpacingGreaterThanMaxBidPrice":
    case "FloorPriceAndTickSpacingTooLarge":
      return { title: "The auction refused this floor and tick", body: "The floor must be a whole number of ticks, and the tick at least 0.000001 USDC." };
    case "DurationOutOfRange":
      return { title: "That auction length isn't allowed", body: "Pick one of the listed lengths." };
    default:
      return null;
  }
}

/** The auction a confirmed `shardAndAuction` opened. `refBlock` is the block `endBlock` counts from, for an end date. */
export type ShardCreated = {
  shardToken: Address;
  auction: Address;
  endBlock: bigint;
  refBlock: bigint;
  hash: Hex | null;
  /** "receipt": the CardSharded event; "vault": `cards(id)` (a retry found it already done, or the event was missing). */
  source: "receipt" | "vault";
};

/**
 * What a confirmed shard produced: the CardSharded event from the receipt of `hash`, else the vault's record of the card.
 * Null when neither can be read; the success state then shows the transaction alone.
 */
export async function shardOutcome(
  hash: Hex | undefined,
  deps: {
    getReceipt: (hash: Hex) => Promise<{ blockNumber: bigint; logs: readonly Log[] }>;
    readLogs: (logs: readonly Log[]) => Sharded | null;
    readCard: () => Promise<{ shardToken: Address; auction: Address; endBlock: bigint }>;
    getBlockNumber: () => Promise<bigint>;
  },
): Promise<ShardCreated | null> {
  if (hash) {
    try {
      const receipt = await deps.getReceipt(hash);
      const s = deps.readLogs(receipt.logs);
      if (s) return { shardToken: s.shardToken, auction: s.auction, endBlock: s.endBlock, refBlock: receipt.blockNumber, hash, source: "receipt" };
    } catch {
      // Fall through to the vault's record.
    }
  }
  try {
    const [card, block] = await Promise.all([deps.readCard(), deps.getBlockNumber()]);
    return { shardToken: card.shardToken, auction: card.auction, endBlock: card.endBlock, refBlock: block, hash: hash ?? null, source: "vault" };
  } catch {
    return null;
  }
}
