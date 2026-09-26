/**
 * Earlier deployments' CardNames adapters. Collector handles claimed through them (`<handle>.kura.eth`) still live in
 * the shared ENS registry and resolve, and a wallet can't claim a second one, so the indexer reads their
 * CollectorNamed events (and the collectors' own resolvers) to keep showing those wallets by handle. Their card names
 * are not indexed: they belong to the earlier vaults' card ids, which collide with this deployment's.
 * Add an entry here whenever a redeploy replaces CardNames (address and deploy block from the old sepolia.json).
 */
export const LEGACY_CARD_NAMES: readonly { address: `0x${string}`; startBlock: number }[] = [
  { address: "0x93f5A4c05A6Ba8f785463efD3C15B34c72C63c49", startBlock: 11779718 },
];
