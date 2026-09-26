import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pub = vi.hoisted(() => ({ calls: [] as bigint[], fail: false, invalidations: 0 }));
vi.mock("@/lib/settled-appraisal", () => ({
  publishSettledAppraisal: vi.fn(async (id: bigint) => {
    if (pub.fail) throw new Error("indexer down");
    pub.calls.push(id);
    return "written";
  }),
}));
vi.mock("@/lib/multibaas/server", () => ({ invalidateMultibaasFigures: () => { pub.invalidations++; } }));

import { createTestDb } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { multibaasDeliveries } from "@/lib/db/schema";
import { deployments } from "@/lib/deployments";
import { signMultibaas } from "@/lib/multibaas/webhook";
import { POST } from "@/app/api/webhooks/multibaas/route";
import { settledDelivery } from "./fixtures/multibaas";

const SECRET = "whsec-test";
const nowSec = () => Math.floor(Date.now() / 1000);
const enc = (s: string) => new TextEncoder().encode(s);

function post(body: string, o: { ts?: number; signature?: string | null; secret?: string } = {}) {
  const ts = String(o.ts ?? nowSec());
  const signature = o.signature === undefined ? signMultibaas(enc(body), ts, o.secret ?? SECRET) : o.signature;
  const headers: Record<string, string> = { "content-type": "application/json", "x-multibaas-timestamp": ts };
  if (signature !== null) headers["x-multibaas-signature"] = signature;
  return POST(new Request("http://x/api/webhooks/multibaas", { method: "POST", headers, body }));
}

describe("POST /api/webhooks/multibaas", () => {
  const vault = () => deployments().cardVault;
  const body = (card = 4, id?: string) => JSON.stringify([settledDelivery(vault(), { card, id })]);
  let quiet: { mockRestore: () => void }[] = [];

  beforeEach(async () => {
    await createTestDb();
    process.env.MULTIBAAS_WEBHOOK_SECRET = SECRET;
    pub.calls = [];
    pub.fail = false;
    pub.invalidations = 0;
    // Only the console spies are restored: the mocked publishSettledAppraisal must keep its implementation.
    quiet = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  });
  afterEach(() => {
    delete process.env.MULTIBAAS_WEBHOOK_SECRET;
    for (const s of quiet) s.mockRestore();
  });

  it("refuses unsigned, forged, tampered and replayed-old deliveries, touching nothing", async () => {
    const ts = nowSec();
    const original = body(4);
    for (const res of [
      await post(original, { signature: null }),
      await post(original, { secret: "not-the-secret" }),
      await post(body(5), { ts, signature: signMultibaas(enc(original), String(ts), SECRET) }),
      await post(original, { ts: ts - 3600 }),
    ]) {
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
    }
    expect(await getDb().select().from(multibaasDeliveries)).toEqual([]);
    expect(pub.calls).toEqual([]);
    expect(pub.invalidations).toBe(0);
  });

  it("answers 503 without a configured secret, so MultiBaas keeps the delivery", async () => {
    delete process.env.MULTIBAAS_WEBHOOK_SECRET;
    const res = await post(body());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("UNCONFIGURED");
  });

  it("answers 400 for a signed body that is not a delivery array", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post('{"id":"x"}')).status).toBe(400);
    expect((await post("[]")).status).toBe(400);
  });

  it("publishes a settled card's appraisal once, a redelivery under a new id included, and drops the dashboard memo", async () => {
    const first = await post(body(4));
    expect(first.status).toBe(200);
    expect((await first.json()).results).toEqual([{ id: "delivery-4-3", outcome: "written" }]);
    expect(pub.invalidations).toBe(1);
    const again = await post(body(4, "a-new-delivery-id"));
    expect((await again.json()).results).toEqual([{ id: "a-new-delivery-id", outcome: "duplicate" }]);
    expect(pub.calls).toEqual([4n]);
  });

  it("asks MultiBaas to retry (503) when the appraisal fails, and succeeds on the retry", async () => {
    pub.fail = true;
    expect((await post(body(6))).status).toBe(503);
    pub.fail = false;
    const retry = await post(body(6));
    expect(retry.status).toBe(200);
    expect((await retry.json()).results[0].outcome).toBe("written");
    expect(pub.calls).toEqual([6n]);
  });
});
