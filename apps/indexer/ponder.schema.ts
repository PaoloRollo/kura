import { index, onchainEnum, onchainTable, primaryKey } from "ponder";

export const cardState = onchainEnum("card_state", ["whole", "auctioning", "sharded", "released"]);
export const feeKind = onchainEnum("fee_kind", ["sale", "buyout"]);
export const nameKind = onchainEnum("name_kind", ["card", "collector", "agent"]);
export const bidStatus = onchainEnum("bid_status", ["open", "exited", "claimed"]);
export const activityKind = onchainEnum("activity_kind", [
  "mint", "shard", "bid", "exit", "claim", "settle", "redeem", "payout", "release", "named", "transfer",
]);

export const cards = onchainTable("cards", (t) => ({
  id: t.bigint().primaryKey(),
  state: cardState("state").notNull(),
  ownerOf: t.hex().notNull(),
  // Holder the card belongs to (the owner while it sits in vault escrow). Intentionally keeps following the NFT holder
  // after release, whereas the contract's stored beneficialOwner stops updating once the card is released.
  beneficialOwner: t.hex().notNull(),
  scryfallId: t.text().notNull(),
  condition: t.text().notNull(),
  language: t.text().notNull(),
  label: t.text().notNull(),
  ensName: t.text().notNull(),
  shardToken: t.hex(),
  auction: t.hex(),
  endBlock: t.bigint(),
  mintedAt: t.integer().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedAt: t.integer().notNull(),
}), (table) => ({ stateIdx: index().on(table.state), ownerIdx: index().on(table.beneficialOwner) }));

export const shardings = onchainTable("shardings", (t) => ({
  shardToken: t.hex().primaryKey(),
  cardId: t.bigint().notNull(),
  auction: t.hex().notNull(),
  totalShards: t.integer().notNull(),
  forSale: t.integer().notNull(),
  floorPriceQ96: t.bigint().notNull(),
  tickSpacingQ96: t.bigint().notNull(),
  reserveUsdc: t.bigint().notNull(),
  startBlock: t.bigint().notNull(),
  endBlock: t.bigint().notNull(),
  settled: t.boolean().notNull(),
  // Null until the auction's graduation is known.
  graduated: t.boolean(),
  // Raw final clearing price as reported by the auction.
  clearingPriceQ96: t.bigint(),
  // q96ToUsdcPerShard(clearingPriceQ96); null when the auction did not graduate.
  clearingUsdcPerShard: t.bigint(),
  raisedUsdc: t.bigint(),
  feeUsdc: t.bigint(),
  buyoutPerShard: t.bigint(),
  payoutUsdc: t.bigint(),
  redeemer: t.hex(),
  createdAt: t.integer().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedAt: t.integer().notNull(),
}), (table) => ({ cardIdx: index().on(table.cardId) }));

export const activeAuctions = onchainTable("active_auctions", (t) => ({
  auction: t.hex().primaryKey(),
  cardId: t.bigint().notNull(),
  shardToken: t.hex().notNull(),
  startBlock: t.bigint().notNull(),
  endBlock: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.integer().notNull(),
}));

export const shardBalances = onchainTable("shard_balances", (t) => ({
  id: t.text().primaryKey(), // holderId(token, holder)
  shardToken: t.hex().notNull(),
  holder: t.hex().notNull(),
  balance: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedAt: t.integer().notNull(),
}), (table) => ({ tokenIdx: index().on(table.shardToken), holderIdx: index().on(table.holder) }));

export const shardTransfers = onchainTable("shard_transfers", (t) => ({
  id: t.text().primaryKey(), // logId
  shardToken: t.hex().notNull(),
  from: t.hex().notNull(),
  to: t.hex().notNull(),
  amount: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.integer().notNull(),
}), (table) => ({ tokenIdx: index().on(table.shardToken) }));

export const bids = onchainTable("bids", (t) => ({
  id: t.text().primaryKey(), // bidRowId(auction, bidId)
  auction: t.hex().notNull(),
  bidId: t.bigint().notNull(),
  cardId: t.bigint().notNull(),
  shardToken: t.hex().notNull(),
  owner: t.hex().notNull(),
  maxPriceQ96: t.bigint().notNull(),
  amountUsdc: t.bigint().notNull(),
  submittedBlock: t.bigint().notNull(),
  submittedAt: t.integer().notNull(),
  // Only persisted bid state: "open" -> "exited" -> "claimed"; a zero-fill exited bid stays "exited" (final).
  // Consumers derive exited/claimed booleans from it at read time.
  status: bidStatus("status").notNull(),
  tokensFilled: t.bigint(),
  currencyRefunded: t.bigint(),
  updatedBlock: t.bigint().notNull(),
  updatedAt: t.integer().notNull(),
}), (table) => ({ auctionIdx: index().on(table.auction), ownerIdx: index().on(table.owner) }));

export const auctionTicks = onchainTable("auction_ticks", (t) => ({
  id: t.text().primaryKey(), // tickId(auction, block)
  auction: t.hex().notNull(),
  cardId: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.integer().notNull(),
  clearingPriceQ96: t.bigint().notNull(),
  clearingUsdcPerShard: t.bigint().notNull(),
  currencyRaised: t.bigint().notNull(),
  totalCleared: t.bigint().notNull(),
}), (table) => ({ auctionIdx: index().on(table.auction) }));

export const checkpoints = onchainTable("checkpoints", (t) => ({
  id: t.text().primaryKey(), // checkpointId(auction, blockNumber)
  auction: t.hex().notNull(),
  // Checkpoint block from the event args. It can differ from the emitting log's block (notably the END_BLOCK
  // checkpoint, written later by the first post-end call), which is where `timestamp` comes from.
  blockNumber: t.bigint().notNull(),
  clearingPriceQ96: t.bigint().notNull(),
  cumulativeMps: t.bigint().notNull(),
  timestamp: t.integer().notNull(), // emitting log's block timestamp
}), (table) => ({ auctionIdx: index().on(table.auction) }));

export const feeEvents = onchainTable("fee_events", (t) => ({
  id: t.text().primaryKey(), // logId(txHash, logIndex)
  cardId: t.bigint().notNull(),
  kind: feeKind("kind").notNull(),
  amountUsdc: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.integer().notNull(),
}));

export const payoutClaims = onchainTable("payout_claims", (t) => ({
  id: t.text().primaryKey(), // logId(txHash, logIndex)
  cardId: t.bigint().notNull(),
  shardToken: t.hex().notNull(),
  holder: t.hex().notNull(),
  shardUnits: t.bigint().notNull(),
  usdc: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.integer().notNull(),
}));

export const activities = onchainTable("activities", (t) => ({
  id: t.text().primaryKey(), // logId(txHash, logIndex)
  kind: activityKind("kind").notNull(),
  cardId: t.bigint(),
  actor: t.hex().notNull(),
  amount: t.bigint(),
  meta: t.json(),
  txHash: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.integer().notNull(),
}), (table) => ({ cardIdx: index().on(table.cardId), actorIdx: index().on(table.actor), timeIdx: index().on(table.timestamp) }));

export const ensNames = onchainTable("ens_names", (t) => ({
  label: t.text().primaryKey(),
  labelHash: t.hex().notNull(), // keccak256(label)
  kind: nameKind("kind").notNull(),
  node: t.hex(),
  // ENSv2 tokenId; compare with sameEnsToken (low 32 bits are a version).
  tokenId: t.bigint(),
  // Registry owner of the name. For card names this is the CardNames adapter, not the card holder.
  owner: t.hex(),
  resolver: t.hex(),
  cardId: t.bigint(),
  expiry: t.bigint(),
  registeredAt: t.integer().notNull(),
  revokedAt: t.integer(),
  updatedBlock: t.bigint().notNull(),
  updatedAt: t.integer().notNull(),
}));

export const ensRecords = onchainTable("ens_records", (t) => ({
  node: t.hex().notNull(),
  key: t.text().notNull(),
  value: t.text().notNull(),
  setBy: t.hex().notNull(),
  resolver: t.hex().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedAt: t.integer().notNull(),
}), (table) => ({ pk: primaryKey({ columns: [table.node, table.key] }) }));

export const collectors = onchainTable("collectors", (t) => ({
  address: t.hex().primaryKey(),
  label: t.text().notNull(),
  resolver: t.hex().notNull(),
  node: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
  registeredAt: t.integer().notNull(),
}), (table) => ({
  // CollectorResolver records are only accepted for the collector's own node; handlers look the collector up by resolver.
  resolverIdx: index().on(table.resolver),
}));

export const bidderBindings = onchainTable("bidder_bindings", (t) => ({
  nullifier: t.bigint().primaryKey(),
  wallet: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
  boundAt: t.integer().notNull(),
}));
