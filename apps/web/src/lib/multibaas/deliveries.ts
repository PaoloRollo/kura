import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { multibaasDeliveries } from "@/lib/db/schema";

/** A claim still "processing" this long after its last update is taken over: its handler died mid-delivery. */
export const DELIVERY_STALE_SEC = 300;

export type DeliveryClaim = { key: string; deliveryId: string; eventName: string; cardId: bigint | null };

/**
 * Claims a MultiBaas log for processing, once across retries, duplicates, replays and instances. The claim's token (the
 * row's new `attempts`) when this call owns it (first delivery, a failed earlier attempt, or a claim gone stale); null
 * when it is done or another handler is on it right now. One statement (insert … on conflict do update … where), so two
 * concurrent deliveries can't both win. Pass the token to finishDelivery.
 */
export async function claimDelivery(c: DeliveryClaim): Promise<number | null> {
  const t = multibaasDeliveries;
  const rows = await getDb()
    .insert(t)
    .values({ eventKey: c.key, deliveryId: c.deliveryId, eventName: c.eventName, cardId: c.cardId })
    .onConflictDoUpdate({
      target: t.eventKey,
      set: { status: "processing", deliveryId: c.deliveryId, attempts: sql`${t.attempts} + 1`, updatedAt: sql`now()` },
      setWhere: sql`${t.status} = 'failed' or (${t.status} = 'processing' and ${t.updatedAt} < now() - ${sql.raw(`interval '${DELIVERY_STALE_SEC} seconds'`)})`,
    })
    .returning({ attempts: t.attempts });
  return rows[0]?.attempts ?? null;
}

/**
 * Records how a claimed log ended: done (whatever the outcome) or failed (the next delivery retries it). Only while the
 * row is still this claim (`attempt`, claimDelivery's token, and still processing): a handler whose claim went stale and
 * was taken over never overwrites the newer claim. False when the claim was no longer this call's.
 */
export async function finishDelivery(key: string, attempt: number, status: "done" | "failed", outcome: string): Promise<boolean> {
  const t = multibaasDeliveries;
  const rows = await getDb()
    .update(t)
    .set({ status, outcome, updatedAt: sql`now()` })
    .where(and(eq(t.eventKey, key), eq(t.attempts, attempt), eq(t.status, "processing")))
    .returning({ key: t.eventKey });
  return rows.length === 1;
}
