// Identical to the indexer's lib/math.ts: USDC (6 decimals) per whole shard <-> the auction's Q96 price.
const Q96 = 2n ** 96n;
const SHARD = 10n ** 18n;
/** USDC per whole shard from a Q96 price; floor division, matching the contracts. */
export const q96ToUsdcPerShard = (priceQ96: bigint) => (priceQ96 * SHARD) / Q96;
/** Q96 price for a USDC-per-shard amount; ceil, so converting back floors to the same value. */
export const usdcPerShardToQ96 = (usdc: bigint) => (usdc * Q96 + SHARD - 1n) / SHARD;
