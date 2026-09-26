import { ponder } from "ponder:registry";
import { shardBalances, shardTransfers } from "ponder:schema";
import deployments from "../generated/deployments.json";
import { balanceDeltas } from "./lib/auction-state";
import { isPoolHolder } from "./lib/market";
import { holderId, logId } from "./lib/ids";

// Every address, the auction contract and the vault included, is a holder row; the dashboards decide how to label them.
// The v4 PoolManager (every pool's shards) is tagged isPool.
ponder.on("ShardToken:Transfer", async ({ event, context }) => {
  const token = event.log.address;
  const block = event.block.number;
  const ts = Number(event.block.timestamp);
  const { from, to, value } = event.args;
  await context.db.insert(shardTransfers).values({
    id: logId(event.transaction.hash, event.log.logIndex),
    shardToken: token,
    from,
    to,
    amount: value,
    blockNumber: block,
    timestamp: ts,
  }).onConflictDoNothing();
  for (const { holder, delta } of balanceDeltas(from, to, value)) {
    await context.db
      .insert(shardBalances)
      .values({ id: holderId(token, holder), shardToken: token, holder, balance: delta, isPool: isPoolHolder(holder, deployments.poolManager), updatedBlock: block, updatedAt: ts })
      .onConflictDoUpdate((row) => ({ balance: row.balance + delta, updatedBlock: block, updatedAt: ts }));
  }
});
