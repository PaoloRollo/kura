import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pub = vi.hoisted(() => ({ calls: [] as bigint[], fail: false, invalidations: 0, onPublish: null as null | (() => void) }));
vi.mock("@/lib/settled-appraisal", () => ({
  publishSettledAppraisal: vi.fn(async (id: bigint) => {
    if (pub.fail) throw new Error("indexer down");
    pub.onPublish?.();
    pub.calls.push(id);
    return "written";
  }),
}));
vi.mock("@/lib/multibaas/server", () => ({ invalidateMultibaasFigures: () => { pub.invalidations++; } }));

import { createTestDb } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { multibaasDeliveries } from "@/lib/db/schema";
import { deployments } from "@/lib/deployments";
import { MAX_WEBHOOK_BODY_BYTES, WEBHOOK_DEADLINE_MS, signMultibaas } from "@/lib/multibaas/webhook";
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
    pub.onPublish = null;
    // Only the console spies are restored: the mocked publishSettledAppraisal must keep its implementation.
    quiet = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  });
  afterEach(() => {
    delete process.env.MULTIBAAS_WEBHOOK_SECRET;
    for (const s of quiet) s.mockRestore();
    vi.useRealTimers();
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

  it("answers 413 for a body over MAX_WEBHOOK_BODY_BYTES, by Content-Length or as it streams, before checking anything", async () => {
    const big = JSON.stringify([settledDelivery(vault(), { card: 4, id: "x".repeat(150) })]).padEnd(MAX_WEBHOOK_BODY_BYTES + 1, " ");
    const ts = String(nowSec());
    const headers = { "x-multibaas-timestamp": ts, "x-multibaas-signature": signMultibaas(enc(big), ts, SECRET) };
    const unread = new ReadableStream<Uint8Array>();
    const declared = { headers: new Headers({ ...headers, "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1) }), body: unread } as unknown as Request;
    const res = await POST(declared);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("TOO_LARGE");
    expect(unread.locked).toBe(false);
    const bytes = enc(big);
    const streamed = new Request("http://x/api/webhooks/multibaas", {
      method: "POST",
      headers,
      body: new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 600_000)); c.enqueue(bytes.slice(600_000)); c.close(); } }),
      duplex: "half",
    } as RequestInit);
    expect((await POST(streamed)).status).toBe(413);
    expect(await getDb().select().from(multibaasDeliveries)).toEqual([]);
    expect(pub.calls).toEqual([]);
  });

  it("ignores the odd items of a signed batch instead of refusing it", async () => {
    const res = await post(JSON.stringify([{ nope: true }, settledDelivery(vault(), { card: 4 })]));
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([{ id: "#0", outcome: "ignored" }, { id: "delivery-4-3", outcome: "written" }]);
    expect(pub.calls).toEqual([4n]);
  });

  it("defers the appraisals left once WEBHOOK_DEADLINE_MS has passed, still 200", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    pub.onPublish = () => vi.setSystemTime(Date.now() + WEBHOOK_DEADLINE_MS);
    const res = await post(JSON.stringify([7, 8].map((card) => settledDelivery(vault(), { card }))));
    expect(res.status).toBe(200);
    expect((await res.json()).results.map((r: { outcome: string }) => r.outcome)).toEqual(["written", "deferred"]);
    expect(pub.calls).toEqual([7n]);
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
