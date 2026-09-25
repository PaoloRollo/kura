import { ponder } from "ponder:registry";
import { activeAuctions, cards, feeEvents, payoutClaims, shardings } from "ponder:schema";
import deployments from "../generated/deployments.json";
import { recordActivity } from "./lib/activity";
import { logId } from "./lib/ids";
import { redeemedCardPatch, settlementPatch, shardActivity, shardedCardPatch, transferPatch } from "./lib/vault-state";

const parent = deployments.ensParentLabel;
const ZERO = "0x0000000000000000000000000000000000000000";

ponder.on("CardVault:CardMinted", async ({ event, context }) => {
  const ts = Number(event.block.timestamp);
  await context.db.insert(cards).values({
    id: event.args.id,
    state: "whole",
    ownerOf: event.args.to,
    beneficialOwner: event.args.to,
    scryfallId: event.args.scryfallId,
    condition: event.args.condition,
    language: event.args.language,
    label: event.args.label,
    ensName: `${event.args.label}.${parent}.eth`,
    shardToken: null,
    auction: null,
    endBlock: null,
    mintedAt: ts,
    updatedBlock: event.block.number,
    updatedAt: ts,
  }).onConflictDoNothing();
  await recordActivity(context, event, { kind: "mint", cardId: event.args.id, actor: event.args.to, meta: { label: event.args.label } });
});

// ERC-721 transfers keep ownerOf current; escrow moves are recognised by the vault address.
// The mint Transfer (from zero) precedes CardMinted in the same tx and is skipped; CardMinted creates the row.
ponder.on("CardVault:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args;
  if (from === ZERO) return;
  let isUserTransfer = false;
  await context.db.update(cards, { id: tokenId }).set((row) => {
    const p = transferPatch({ beneficialOwner: row.beneficialOwner, from, to, vault: deployments.cardVault });
    isUserTransfer = p.isUserTransfer;
    return { ownerOf: p.ownerOf, beneficialOwner: p.beneficialOwner, updatedBlock: event.block.number, updatedAt: Number(event.block.timestamp) };
  });
  if (isUserTransfer) {
    await recordActivity(context, event, { kind: "transfer", cardId: tokenId, actor: from, meta: { to } });
  }
});

// Shardings are keyed by shard token, so a card sharded again gets a second row; the card points at the latest.
ponder.on("CardVault:CardSharded", async ({ event, context }) => {
  const ts = Number(event.block.timestamp);
  const a = event.args;
  await context.db.insert(shardings).values({
    shardToken: a.shardToken,
    cardId: a.id,
    auction: a.auction,
    totalShards: a.totalShards,
    forSale: a.forSale,
    floorPriceQ96: a.floorPriceQ96,
    tickSpacingQ96: a.tickSpacingQ96,
    reserveUsdc: a.reserveUsdc,
    startBlock: a.startBlock,
    endBlock: a.endBlock,
    settled: false,
    graduated: null,
    clearingPriceQ96: null,
    clearingUsdcPerShard: null,
    raisedUsdc: null,
    feeUsdc: null,
    buyoutPerShard: null,
    payoutUsdc: null,
    redeemer: null,
    createdAt: ts,
    updatedBlock: event.block.number,
    updatedAt: ts,
  }).onConflictDoNothing();
  await context.db.insert(activeAuctions).values({
    auction: a.auction,
    cardId: a.id,
    shardToken: a.shardToken,
    endBlock: a.endBlock,
    blockNumber: event.block.number,
    timestamp: ts,
  }).onConflictDoNothing();
  // The escrow Transfer precedes CardSharded and keeps beneficialOwner, so the returned row names the card owner.
  const card = await context.db.update(cards, { id: a.id }).set({ ...shardedCardPatch(a), updatedBlock: event.block.number, updatedAt: ts });
  await recordActivity(context, event, { kind: "shard", cardId: a.id, ...shardActivity({ owner: card.beneficialOwner, ...a }) });
});

ponder.on("CardVault:AuctionSettled", async ({ event, context }) => {
  const ts = Number(event.block.timestamp);
  const a = event.args;
  const patch = settlementPatch(a);
  const row = await context.db.update(shardings, { shardToken: a.shardToken }).set({ ...patch, updatedBlock: event.block.number, updatedAt: ts });
  await context.db.delete(activeAuctions, { auction: row.auction });
  await context.db.update(cards, { id: a.id }).set({ state: "sharded", updatedBlock: event.block.number, updatedAt: ts });
  await recordActivity(context, event, {
    kind: "settle",
    cardId: a.id,
    // settle is permissionless: the caller is whoever sent the tx, which under gas sponsorship may be a relayer.
    actor: event.transaction.from,
    amount: a.raisedUsdc,
    meta: {
      graduated: a.graduated,
      shardToken: a.shardToken,
      clearingUsdcPerShard: patch.clearingUsdcPerShard === null ? null : patch.clearingUsdcPerShard.toString(),
    },
  });
});

ponder.on("CardVault:CardRedeemed", async ({ event, context }) => {
  const ts = Number(event.block.timestamp);
  const a = event.args;
  await context.db.update(shardings, { shardToken: a.shardToken }).set({
    buyoutPerShard: a.buyoutPerShard,
    payoutUsdc: a.payoutUsdc,
    redeemer: a.redeemer,
    updatedBlock: event.block.number,
    updatedAt: ts,
  });
  await context.db.update(cards, { id: a.id }).set({ ...redeemedCardPatch(a.redeemer), updatedBlock: event.block.number, updatedAt: ts });
  await recordActivity(context, event, {
    kind: "redeem",
    cardId: a.id,
    actor: a.redeemer,
    amount: a.payoutUsdc,
    meta: { buyoutPerShard: a.buyoutPerShard.toString(), fee: a.feeUsdc.toString(), shardToken: a.shardToken },
  });
});

ponder.on("CardVault:PayoutClaimed", async ({ event, context }) => {
  const a = event.args;
  await context.db.insert(payoutClaims).values({
    id: logId(event.transaction.hash, event.log.logIndex),
    cardId: a.id,
    shardToken: a.shardToken,
    holder: a.holder,
    shardUnits: a.shardUnits,
    usdc: a.usdc,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
  }).onConflictDoNothing();
  await recordActivity(context, event, { kind: "payout", cardId: a.id, actor: a.holder, amount: a.usdc, meta: { shardUnits: a.shardUnits.toString(), shardToken: a.shardToken } });
});

ponder.on("CardVault:CardReleased", async ({ event, context }) => {
  await context.db.update(cards, { id: event.args.id }).set({ state: "released", updatedBlock: event.block.number, updatedAt: Number(event.block.timestamp) });
  await recordActivity(context, event, { kind: "release", cardId: event.args.id, actor: event.args.holder });
});

ponder.on("CardVault:FeeAccrued", async ({ event, context }) => {
  await context.db.insert(feeEvents).values({
    id: logId(event.transaction.hash, event.log.logIndex),
    cardId: event.args.id,
    kind: event.args.kind === 0 ? "sale" : "buyout",
    amountUsdc: event.args.amountUsdc,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
  }).onConflictDoNothing();
});
