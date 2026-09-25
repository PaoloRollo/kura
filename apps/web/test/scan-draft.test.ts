import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/migrate";
import { setUserForTests } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { scanDrafts } from "@/lib/db/schema";
import deployments from "@/generated/deployments.json";
import { POST as draftRoute } from "@/app/api/scan/draft/route";

const vendor = deployments.vendor as `0x${string}`;
const alice = "0x1111111111111111111111111111111111111111" as const;

const candidate = {
  scryfallId: "c1",
  name: "Black Lotus",
  printedName: null,
  lang: "en",
  set: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "232",
  rarity: "rare",
  image: "https://img/n.jpg",
  imageSmall: "https://img/s.jpg",
  prices: { usd: "25000.00", usdFoil: null, eur: "20000.00" },
  finishes: ["nonfoil"],
  slug: "black-lotus",
  setCode: "lea",
};

const post = (body: unknown, raw?: string) =>
  new Request("http://localhost/api/scan/draft", { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });

describe("POST /api/scan/draft", () => {
  beforeEach(async () => {
    await createTestDb();
    setUserForTests({ did: "did:vendor", wallet: vendor });
  });

  it("persists a manual scan draft for the picked candidate", async () => {
    const res = await draftRoute(post({ candidate }));
    expect(res.status).toBe(200);
    const { draftId } = (await res.json()) as { draftId: string };
    const [draft] = await getDb().select().from(scanDrafts).where(eq(scanDrafts.id, draftId));
    expect(draft.method).toBe("manual");
    expect(draft.vendorWallet).toBe(vendor);
    expect(draft.candidates).toEqual([candidate]);
    expect(draft.chosenScryfallId).toBeNull();
  });

  it("refuses non-vendors", async () => {
    setUserForTests({ did: "did:alice", wallet: alice });
    const res = await draftRoute(post({ candidate }));
    expect(res.status).toBe(403);
  });

  it("rejects a malformed candidate", async () => {
    const res = await draftRoute(post({ candidate: { name: "no id" } }));
    expect(res.status).toBe(400);
  });
});
