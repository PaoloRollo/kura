import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { multibaasDeliveries } from "@/lib/db/schema";

/** A claim still "processing" this long after its last update is taken over: its handler died mid-delivery. */
export const DELIVERY_STALE_SEC = 300;

export type DeliveryClaim = { key: string; deliveryId: string; eventName: string; cardId: bigint | null };

/**
 * Claims a MultiBaas log for processing, once across retries, duplicates, replays and instances. True when this call owns
 * it (first delivery, a failed earlier attempt, or a claim gone stale); false when it is done or another handler is on it
 * right now. One statement (insert … on conflict do update … where), so two concurrent deliveries can't both win.
 */
export async function claimDelivery(c: DeliveryClaim): Promise<boolean> {
  const t = multibaasDeliveries;
  const rows = await getDb()
    .insert(t)
    .values({ eventKey: c.key, deliveryId: c.deliveryId, eventName: c.eventName, cardId: c.cardId })
    .onConflictDoUpdate({
      target: t.eventKey,
      set: { status: "processing", deliveryId: c.deliveryId, attempts: sql`${t.attempts} + 1`, updatedAt: sql`now()` },
      setWhere: sql`${t.status} = 'failed' or (${t.status} = 'processing' and ${t.updatedAt} < now() - ${sql.raw(`interval '${DELIVERY_STALE_SEC} seconds'`)})`,
    })
    .returning({ key: t.eventKey });
  return rows.length === 1;
}

/** Records how a claimed log ended: done (whatever the outcome) or failed (the next delivery retries it). */
export async function finishDelivery(key: string, status: "done" | "failed", outcome: string): Promise<void> {
  await getDb().update(multibaasDeliveries).set({ status, outcome, updatedAt: sql`now()` }).where(eq(multibaasDeliveries.eventKey, key));
}
