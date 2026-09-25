import { ponder } from "ponder:registry";
import { abi } from "@kura/shared";
import { activeAuctions, auctionTicks, bidderBindings, bids, checkpoints, shardings } from "ponder:schema";
import { recordActivity } from "./lib/activity";
import { checkpointRow, claimPatch, exitPatch, isSampleable } from "./lib/auction-state";
import { bidRowId, tickId } from "./lib/ids";
import { q96ToUsdcPerShard } from "./lib/math";

const ZERO = "0x0000000000000000000000000000000000000000";

// Bidders are the event's owner arg, never transaction.from (Privy gas sponsorship can relay the tx).
ponder.on("Auction:BidSubmitted", async ({ event, context }) => {
  const auction = event.log.address;
  const ts = Number(event.block.timestamp);
  const active = await context.db.find(activeAuctions, { auction });
  await context.db.insert(bids).values({
    id: bidRowId(auction, event.args.id),
    auction,
    bidId: event.args.id,
    cardId: active?.cardId ?? 0n,
    shardToken: active?.shardToken ?? ZERO,
    owner: event.args.owner,
    maxPriceQ96: event.args.priceQ96,
    amountUsdc: event.args.amount,
    submittedBlock: event.block.number,
    submittedAt: ts,
    status: "open",
    tokensFilled: null,
    currencyRefunded: null,
    updatedBlock: event.block.number,
    updatedAt: ts,
  }).onConflictDoNothing();
  await recordActivity(context, event, {
    kind: "bid",
    cardId: active?.cardId ?? null,
    actor: event.args.owner,
    amount: event.args.amount,
    meta: { auction, bidId: event.args.id.toString(), maxUsdcPerShard: q96ToUsdcPerShard(event.args.priceQ96).toString() },
  });
  // Keep the sharding's latest known clearing price fresh while live, so card pages can show it without a tick join.
  // Merged here because Ponder registers one handler per event name; AuctionSettled overwrites it with the final price.
  if (!active) return;
  const clearingPriceQ96 = await context.client.readContract({ abi: abi.ccaAuction, address: auction, functionName: "clearingPrice" });
  await context.db.update(shardings, { shardToken: active.shardToken }).set({
    clearingPriceQ96,
    clearingUsdcPerShard: q96ToUsdcPerShard(clearingPriceQ96),
    updatedBlock: event.block.number,
    updatedAt: ts,
  });
});

ponder.on("Auction:BidExited", async ({ event, context }) => {
  const id = bidRowId(event.log.address, event.args.bidId);
  const row = await context.db.update(bids, { id }).set({
    ...exitPatch(event.args),
    updatedBlock: event.block.number,
    updatedAt: Number(event.block.timestamp),
  });
  await recordActivity(context, event, {
    kind: "exit",
    cardId: row.cardId,
    actor: event.args.owner,
    amount: event.args.currencyRefunded,
    meta: { auction: event.log.address, bidId: event.args.bidId.toString(), tokensFilled: event.args.tokensFilled.toString() },
  });
});

ponder.on("Auction:TokensClaimed", async ({ event, context }) => {
  const id = bidRowId(event.log.address, event.args.bidId);
  const row = await context.db.update(bids, { id }).set({
    ...claimPatch(),
    updatedBlock: event.block.number,
    updatedAt: Number(event.block.timestamp),
  });
  await recordActivity(context, event, {
    kind: "claim",
    cardId: row.cardId,
    actor: event.args.owner,
    amount: event.args.tokensFilled,
    meta: { auction: event.log.address, bidId: event.args.bidId.toString() },
  });
});

// Exact price history, also needed for exitPartiallyFilledBid hints.
ponder.on("Auction:CheckpointUpdated", async ({ event, context }) => {
  await context.db
    .insert(checkpoints)
    .values(checkpointRow(event.log.address, event.args, Number(event.block.timestamp)))
    .onConflictDoNothing();
});

// Sample every live auction's state every 5 blocks for the price chart. active_auctions loses its row on settle;
// an ended-but-unsettled auction (or one not yet started) is skipped so no RPC is spent and no misleading tick written.
ponder.on("AuctionTick:block", async ({ event, context }) => {
  const block = event.block.number;
  const live = await context.db.sql.select().from(activeAuctions);
  for (const a of live) {
    if (block > a.endBlock) continue;
    const sharding = await context.db.find(shardings, { shardToken: a.shardToken });
    if (!sharding || !isSampleable(block, sharding.startBlock, a.endBlock)) continue;
    const address = a.auction;
    const [clearingPriceQ96, currencyRaised, totalCleared] = await Promise.all([
      context.client.readContract({ abi: abi.ccaAuction, address, functionName: "clearingPrice" }),
      context.client.readContract({ abi: abi.ccaAuction, address, functionName: "currencyRaised" }),
      context.client.readContract({ abi: abi.ccaAuction, address, functionName: "totalCleared" }),
    ]);
    await context.db.insert(auctionTicks).values({
      id: tickId(address, block),
      auction: address,
      cardId: a.cardId,
      blockNumber: block,
      timestamp: Number(event.block.timestamp),
      clearingPriceQ96,
      clearingUsdcPerShard: q96ToUsdcPerShard(clearingPriceQ96),
      currencyRaised,
      totalCleared,
    }).onConflictDoNothing();
  }
});

ponder.on("BidGateHook:BidderBound", async ({ event, context }) => {
  await context.db.insert(bidderBindings).values({
    nullifier: event.args.nullifier,
    wallet: event.args.wallet,
    blockNumber: event.block.number,
    boundAt: Number(event.block.timestamp),
  }).onConflictDoNothing();
});
