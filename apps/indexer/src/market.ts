import { ponder } from "ponder:registry";
import { cards, pools, swaps } from "ponder:schema";
import { abi } from "@kura/shared";
import deployments from "../generated/deployments.json";
import { recordActivity } from "./lib/activity";
import { logId } from "./lib/ids";
import { marketEnabled, poolOpenedActivity, seededPoolRow, swapActivity, swapFromDeltas, swapPoolPatch } from "./lib/market";

// Ponder executes every file under src/, so the handlers are registered only when the deployment has a ShardMarket
// (ponder.config.ts leaves the contract out otherwise, and a handler for an unknown contract fails the build).
if (marketEnabled(deployments.shardMarket)) {
  ponder.on("ShardMarket:PoolSeeded", async ({ event, context }) => {
    const a = event.args;
    // Seeded at settle, while the card sits in vault escrow: the beneficial owner is the owner at shard time.
    const card = await context.db.find(cards, { id: a.cardId });
    const lpOwner = card?.beneficialOwner
      ?? (await context.client.readContract({ abi: abi.shardMarket, address: event.log.address, functionName: "lpOwnerOf", args: [a.cardId] }));
    const row = seededPoolRow({ ...a, lpOwner, timestamp: event.block.timestamp });
    await context.db.insert(pools).values(row).onConflictDoNothing();
    await recordActivity(context, event, {
      cardId: a.cardId,
      ...poolOpenedActivity({ lpOwner, poolId: a.poolId, shardToken: a.shardToken, priceUsdcPerShard: row.priceUsdcPerShard, shardAmount: a.shardAmount, usdcAmount: a.usdcAmount }),
    });
  });

  ponder.on("ShardMarket:ShardSwap", async ({ event, context }) => {
    const a = event.args;
    // The hook sees the router, not the trader: the trader is the transaction sender.
    const trader = event.transaction.from;
    const s = swapFromDeltas(a.shardDelta, a.usdcDelta);
    await context.db.insert(swaps).values({
      id: logId(event.transaction.hash, event.log.logIndex),
      cardId: a.cardId,
      trader,
      ...s,
      sqrtPriceX96: a.sqrtPriceX96,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    }).onConflictDoNothing();
    const pool = await context.db.find(pools, { cardId: a.cardId });
    if (pool) {
      await context.db.update(pools, { cardId: a.cardId }).set(swapPoolPatch(pool, { sqrtPriceX96: a.sqrtPriceX96, usdcAmount: s.usdcAmount, timestamp: event.block.timestamp }));
    }
    await recordActivity(context, event, { cardId: a.cardId, ...swapActivity({ trader, poolId: a.poolId, ...s, sqrtPriceX96: a.sqrtPriceX96 }) });
  });

  ponder.on("ShardMarket:FeesCollected", async ({ event, context }) => {
    const a = event.args;
    const pool = await context.db.find(pools, { cardId: a.cardId });
    if (!pool) return;
    await context.db.update(pools, { cardId: a.cardId }).set({
      lpOwner: a.lpOwner,
      feesShards: pool.feesShards + a.shardAmount,
      feesUsdc: pool.feesUsdc + a.usdcAmount,
    });
  });

  ponder.on("ShardMarket:Unwound", async ({ event, context }) => {
    const pool = await context.db.find(pools, { cardId: event.args.cardId });
    if (!pool) return;
    await context.db.update(pools, { cardId: event.args.cardId }).set({ frozen: true });
  });
}
