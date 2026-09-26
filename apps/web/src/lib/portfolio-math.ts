// Portfolio arithmetic: cost basis over my filled bids, unrealized gain and the reference price of a sharding. Pure.
const SHARD = 10n ** 18n;

type BidLike = { status: "open" | "exited" | "claimed"; amountUsdc: bigint; currencyRefunded: bigint | null; tokensFilled: bigint | null };
type ShardingLike = { settled: boolean; graduated: boolean | null; redeemer: string | null; buyoutPerShard: bigint | null; clearingUsdcPerShard: bigint | null };

/** USDC paid per whole shard (6 decimals) over my exited or claimed bids that filled; null when nothing filled. */
export function costBasis(bids: readonly BidLike[]): bigint | null {
  let paid = 0n;
  let got = 0n;
  for (const b of bids) {
    if (b.status === "open" || !b.tokensFilled || b.tokensFilled === 0n) continue;
    paid += b.amountUsdc - (b.currencyRefunded ?? 0n);
    got += b.tokensFilled;
  }
  return got === 0n ? null : (paid * SHARD) / got;
}

/** (reference − cost) × balance, in USDC. */
export const unrealized = (refPerShard: bigint, costPerShard: bigint, balance: bigint) => ((refPerShard - costPerShard) * balance) / SHARD;

/**
 * What a shard is worth now: the buyout price once bought out; n/a (null) when the auction did not graduate; else the
 * clearing price (the final one once settled, the live one while the auction runs).
 */
export function referencePrice(s: ShardingLike): bigint | null {
  if (s.redeemer && s.buyoutPerShard != null) return s.buyoutPerShard;
  if (s.graduated === false) return null;
  return s.clearingUsdcPerShard ?? null;
}
