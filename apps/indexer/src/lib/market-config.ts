import { abi } from "@kura/shared";
import { marketEnabled } from "./market";

export type ShardMarketSource = { abi: typeof abi.shardMarket; chain: "sepolia"; address: `0x${string}`; startBlock: number };

/**
 * The ShardMarket contract source, or nothing on a deployment without one (shardMarket is the zero address), so the
 * older deployment keeps indexing. src/market.ts registers its handlers under the same condition.
 */
export function shardMarketSource(address: string, startBlock: number): { ShardMarket?: ShardMarketSource } {
  if (!marketEnabled(address)) return {};
  return { ShardMarket: { abi: abi.shardMarket, chain: "sepolia", address: address as `0x${string}`, startBlock } };
}
