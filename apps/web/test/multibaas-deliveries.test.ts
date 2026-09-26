import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { multibaasDeliveries } from "@/lib/db/schema";
import { DELIVERY_STALE_SEC, claimDelivery, finishDelivery } from "@/lib/multibaas/deliveries";

const c = { key: `0x${"ab".repeat(32)}:3`, deliveryId: "d1", eventName: "AuctionSettled", cardId: 4n };
const row = async () => (await getDb().select().from(multibaasDeliveries).where(eq(multibaasDeliveries.eventKey, c.key)))[0];

describe("MultiBaas delivery claims", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  it("claims a log once; a redelivery while it runs or after it is done is refused", async () => {
    expect(await claimDelivery(c)).toBe(true);
    expect(await claimDelivery({ ...c, deliveryId: "d2" })).toBe(false);
    await finishDelivery(c.key, "done", "written");
    expect(await claimDelivery({ ...c, deliveryId: "d3" })).toBe(false);
    expect(await row()).toMatchObject({ status: "done", outcome: "written", attempts: 1, deliveryId: "d1", cardId: 4n, eventName: "AuctionSettled" });
  });

  it("lets a redelivery retry a failed attempt, counting attempts", async () => {
    await claimDelivery(c);
    await finishDelivery(c.key, "failed", "error");
    expect(await claimDelivery({ ...c, deliveryId: "d2" })).toBe(true);
    expect(await row()).toMatchObject({ status: "processing", attempts: 2, deliveryId: "d2" });
  });

  it("takes over a claim stuck in processing past DELIVERY_STALE_SEC", async () => {
    await claimDelivery(c);
    await getDb().update(multibaasDeliveries).set({ updatedAt: new Date(Date.now() - (DELIVERY_STALE_SEC + 60) * 1000) }).where(eq(multibaasDeliveries.eventKey, c.key));
    expect(await claimDelivery({ ...c, deliveryId: "d2" })).toBe(true);
  });

  it("gives a log to exactly one of two concurrent deliveries", async () => {
    const wins = await Promise.all([claimDelivery(c), claimDelivery({ ...c, deliveryId: "d2" })]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
});
