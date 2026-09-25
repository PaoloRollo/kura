const Q96 = 2n ** 96n;
const SHARD = 10n ** 18n;

/** USDC (6 decimals) per whole shard from a Q96 price; floor division, matching the contracts. */
export function q96ToUsdcPerShard(priceQ96: bigint): bigint {
  return (priceQ96 * SHARD) / Q96;
}

/** Q96 price for a USDC-per-shard amount; ceil, so converting back floors to the same value. */
export function usdcPerShardToQ96(usdc: bigint): bigint {
  return (usdc * Q96 + SHARD - 1n) / SHARD;
}
