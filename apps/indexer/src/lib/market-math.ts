import { usdcPerShardFromSqrtPrice } from "@kura/shared";

const SHARD = 10n ** 18n;

/** USDC raw units (6 dp) per whole shard from a v4 sqrtPriceX96, either token order (shared with the web). */
export { usdcPerShardFromSqrtPrice };

/** Execution price of a swap: USDC raw per whole shard, floored. 0 when no shards moved. */
export function executionPrice(usdcAmount: bigint, shardAmount: bigint): bigint {
  return shardAmount === 0n ? 0n : (usdcAmount * SHARD) / shardAmount;
}
