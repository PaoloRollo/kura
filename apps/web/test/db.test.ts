import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/migrate";
import { marketPrices, worldidVerifications } from "@/lib/db/schema";

describe("app schema", () => {
  it("enforces one nullifier per action", async () => {
    const db = await createTestDb();
    const row = { id: "v1", nullifier: "12345678901234567890", action: "bid", subject: "0xabc", environment: "staging", credential: "proofOfHuman" };
    await db.insert(worldidVerifications).values(row);
    await expect(db.insert(worldidVerifications).values({ ...row, id: "v2" })).rejects.toThrow();
    await db.insert(worldidVerifications).values({ ...row, id: "v3", action: "release" });
    const rows = await db.select().from(worldidVerifications).where(eq(worldidVerifications.action, "bid"));
    expect(rows).toHaveLength(1);
  });

  it("keeps one market price per card per day", async () => {
    const db = await createTestDb();
    await db.insert(marketPrices).values({ scryfallId: "x", date: "2026-09-25", usd: "10.50" });
    await expect(db.insert(marketPrices).values({ scryfallId: "x", date: "2026-09-25", usd: "11" })).rejects.toThrow();
    await db.insert(marketPrices).values({ scryfallId: "x", date: "2026-09-26", usd: "11" });
    expect(await db.select().from(marketPrices)).toHaveLength(2);
  });
});
