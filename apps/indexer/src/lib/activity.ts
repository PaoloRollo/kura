import type { Context } from "ponder:registry";
import { activities } from "ponder:schema";
import { logId } from "./ids";

type EventLike = { transaction: { hash: `0x${string}` }; log: { logIndex: number }; block: { number: bigint; timestamp: bigint } };
type Kind = "mint" | "shard" | "bid" | "exit" | "claim" | "settle" | "redeem" | "payout" | "release" | "named" | "transfer";

export async function recordActivity(
  context: Context,
  event: EventLike,
  fields: { kind: Kind; cardId?: bigint | null; actor: `0x${string}`; amount?: bigint | null; meta?: Record<string, unknown> },
) {
  await context.db.insert(activities).values({
    id: logId(event.transaction.hash, event.log.logIndex),
    kind: fields.kind,
    cardId: fields.cardId ?? null,
    actor: fields.actor,
    amount: fields.amount ?? null,
    meta: fields.meta ?? null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: Number(event.block.timestamp),
  }).onConflictDoNothing();
}
