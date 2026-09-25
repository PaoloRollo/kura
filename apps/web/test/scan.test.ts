import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/migrate";
import { setUserForTests } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { scanDrafts } from "@/lib/db/schema";
import deployments from "@/generated/deployments.json";
import placeholder from "../../../packages/shared/deployments.placeholder.json";
import { resetDeploymentsForTests, setDeploymentsForTests } from "@/lib/deployments";
import { requireVendor } from "@/lib/scan";
import { GET as searchRoute } from "@/app/api/scan/search/route";

const vendor = deployments.vendor as `0x${string}`;
const alice = "0x1111111111111111111111111111111111111111" as const;

describe("requireVendor", () => {
  it("accepts the vendor in any case and refuses everyone else", () => {
    expect(() => requireVendor({ did: "did:vendor", wallet: vendor.toUpperCase().replace("0X", "0x") as `0x${string}` })).not.toThrow();
    expect(() => requireVendor({ did: "did:alice", wallet: alice })).toThrow(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
  });

  afterEach(() => resetDeploymentsForTests());

  it("fails with CONFIG against placeholder deployments, even for the zero address", () => {
    setDeploymentsForTests(placeholder as Parameters<typeof setDeploymentsForTests>[0]);
    const zero = "0x0000000000000000000000000000000000000000" as const;
    expect(() => requireVendor({ did: "did:zero", wallet: zero })).toThrow(expect.objectContaining({ code: "CONFIG", status: 500 }));
  });
});

describe("GET /api/scan/search", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  it("is vendor only and short-circuits short queries", async () => {
    setUserForTests({ did: "did:alice", wallet: alice });
    expect((await searchRoute(new Request("http://localhost/api/scan/search?q=black"))).status).toBe(403);
    setUserForTests({ did: "did:vendor", wallet: vendor });
    const res = await searchRoute(new Request("http://localhost/api/scan/search?q=b"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [] });
  });
});

describe("scan_drafts", () => {
  it("records how the card was identified, defaulting to manual", async () => {
    await createTestDb();
    await getDb().insert(scanDrafts).values({ id: "d1", vendorWallet: vendor, candidates: [] });
    await getDb().insert(scanDrafts).values({ id: "d2", vendorWallet: vendor, candidates: [], method: "embedding" });
    const [d1] = await getDb().select().from(scanDrafts).where(eq(scanDrafts.id, "d1"));
    const [d2] = await getDb().select().from(scanDrafts).where(eq(scanDrafts.id, "d2"));
    expect(d1.method).toBe("manual");
    expect(d2.method).toBe("embedding");
  });
});
