import { formatUnits } from "viem";
import { executionPrice, usdcPerShardFromSqrtPrice } from "./market-math";

type Hex = `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const abs = (x: bigint) => (x < 0n ? -x : x);

/** ShardMarket is indexed only when the deployment has one; older deployments keep indexing without it. */
export const marketEnabled = (shardMarket: string) => shardMarket.toLowerCase() !== ZERO;

/** The v4 PoolManager holds every pool's shards (Kura's locked positions and outside LPs alike). */
export const isPoolHolder = (holder: string, poolManager: string) =>
  poolManager.toLowerCase() !== ZERO && holder.toLowerCase() === poolManager.toLowerCase();

export type SwapSide = "buy" | "sell";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddress = (t: string | undefined) => (t ? (`0x${t.slice(26)}` as Hex).toLowerCase() : undefined);

/**
 * The trader behind a swap. The hook only sees the router, and with Privy gas sponsorship the tx sender can be a relayer,
 * so the trader is read off the swap's own shard Transfer: PoolManager -> trader on a buy, trader -> PoolManager on a sell.
 * Falls back to `fallback` (the tx sender) when the receipt has no such transfer.
 */
export function traderFromLogs(p: {
  logs: readonly { address: string; topics: readonly string[] }[] | undefined;
  side: SwapSide;
  shardToken: string | undefined;
  poolManager: string;
  fallback: Hex;
}): Hex {
  if (!p.logs || !p.shardToken) return p.fallback;
  const pm = p.poolManager.toLowerCase();
  const token = p.shardToken.toLowerCase();
  for (const l of p.logs) {
    if (l.address.toLowerCase() !== token || l.topics[0] !== TRANSFER_TOPIC) continue;
    const from = topicAddress(l.topics[1]);
    const to = topicAddress(l.topics[2]);
    if (p.side === "buy" && from === pm && to) return to as Hex;
    if (p.side === "sell" && to === pm && from) return from as Hex;
  }
  return p.fallback;
}

/** ShardSwap deltas are the trader's balance changes: shardDelta > 0 is a buy. */
export function swapFromDeltas(shardDelta: bigint, usdcDelta: bigint) {
  const shardAmount = abs(shardDelta);
  const usdcAmount = abs(usdcDelta);
  return { side: (shardDelta > 0n ? "buy" : "sell") as SwapSide, shardAmount, usdcAmount, priceUsdcPerShard: executionPrice(usdcAmount, shardAmount) };
}

/** Shards truncated to 4 decimals, grouped: "3.2", "1,500", "0.0012". */
function shardText(units: bigint) {
  const [i, f = ""] = formatUnits(units, 18).split(".");
  const frac = f.slice(0, 4).replace(/0+$/, "");
  return `${BigInt(i!).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** USDC with two decimals, truncated and grouped: "$41.10". */
function moneyText(usdc: bigint) {
  const [i, f = ""] = formatUnits(usdc, 6).split(".");
  return `$${BigInt(i!).toLocaleString("en-US")}.${f.slice(0, 2).padEnd(2, "0")}`;
}

/** "bought 3.2 shards at $41.10". */
export function swapSummary(s: { side: SwapSide; shardAmount: bigint; priceUsdcPerShard: bigint }) {
  const n = shardText(s.shardAmount);
  return `${s.side === "buy" ? "bought" : "sold"} ${n} ${n === "1" ? "shard" : "shards"} at ${moneyText(s.priceUsdcPerShard)}`;
}

/** Swap activity: the amount is the USDC leg (6 dp); shard amount and prices ride in meta as strings. */
export function swapActivity(s: {
  trader: Hex; poolId: Hex; side: SwapSide; shardAmount: bigint; usdcAmount: bigint; priceUsdcPerShard: bigint; sqrtPriceX96: bigint;
}) {
  return {
    kind: "swap" as const,
    actor: s.trader,
    amount: s.usdcAmount,
    meta: {
      side: s.side,
      shardAmount: s.shardAmount.toString(),
      usdcAmount: s.usdcAmount.toString(),
      priceUsdcPerShard: s.priceUsdcPerShard.toString(),
      sqrtPriceX96: s.sqrtPriceX96.toString(),
      poolId: s.poolId,
      summary: swapSummary(s),
    },
  };
}

/** Pool row at PoolSeeded: the opening price, the vault's hand-over and zeroed counters. */
export function seededPoolRow(p: {
  cardId: bigint; poolId: Hex; shardToken: Hex; sqrtPriceX96: bigint; shardIsCurrency0: boolean; shardAmount: bigint; usdcAmount: bigint;
  lpOwner: Hex; timestamp: bigint;
}) {
  return {
    cardId: p.cardId,
    poolId: p.poolId,
    shardToken: p.shardToken,
    shardIsCurrency0: p.shardIsCurrency0,
    sqrtPriceX96: p.sqrtPriceX96,
    priceUsdcPerShard: usdcPerShardFromSqrtPrice(p.sqrtPriceX96, p.shardIsCurrency0),
    seededAt: p.timestamp,
    seedShards: p.shardAmount,
    seedUsdc: p.usdcAmount,
    lastSwapAt: null,
    swapCount: 0,
    volumeUsdc: 0n,
    frozen: false,
    lpOwner: p.lpOwner,
    feesShards: 0n,
    feesUsdc: 0n,
  };
}

/** pool_opened activity: credited to the LP owner, amount = opening USDC per whole shard (6 dp). */
export function poolOpenedActivity(p: { lpOwner: Hex; poolId: Hex; shardToken: Hex; priceUsdcPerShard: bigint; shardAmount: bigint; usdcAmount: bigint }) {
  return {
    kind: "pool_opened" as const,
    actor: p.lpOwner,
    amount: p.priceUsdcPerShard,
    meta: {
      poolId: p.poolId,
      shardToken: p.shardToken,
      priceUsdcPerShard: p.priceUsdcPerShard.toString(),
      seedShards: p.shardAmount.toString(),
      seedUsdc: p.usdcAmount.toString(),
    },
  };
}

/** Pool columns after a swap: price follows the post-swap sqrt price. */
export function swapPoolPatch(pool: { shardIsCurrency0: boolean; swapCount: number; volumeUsdc: bigint }, s: { sqrtPriceX96: bigint; usdcAmount: bigint; timestamp: bigint }) {
  return {
    sqrtPriceX96: s.sqrtPriceX96,
    priceUsdcPerShard: usdcPerShardFromSqrtPrice(s.sqrtPriceX96, pool.shardIsCurrency0),
    lastSwapAt: s.timestamp,
    swapCount: pool.swapCount + 1,
    volumeUsdc: pool.volumeUsdc + s.usdcAmount,
  };
}
