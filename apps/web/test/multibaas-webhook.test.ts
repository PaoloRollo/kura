import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { multibaasDeliveries } from "@/lib/db/schema";
import { DELIVERY_STALE_SEC, claimDelivery, finishDelivery } from "@/lib/multibaas/deliveries";
import {
  MAX_APPRAISALS_PER_REQUEST, MAX_WEBHOOK_BODY_BYTES, WEBHOOK_TOLERANCE_SEC, parseEmitted, processDeliveries, readCappedBody, signMultibaas, verifyMultibaasSignature, type WebhookDeps,
} from "@/lib/multibaas/webhook";
import { settledDelivery } from "./fixtures/multibaas";

const VAULT = "0xEC598d41513A15Bb17D4FAeF5e127aB47A54f1B4";

describe("MultiBaas webhook signatures", () => {
  const body = new TextEncoder().encode('[{"id":"x","event":"event.emitted","data":{}}]');
  const now = 1_790_000_000;
  const ts = String(now);

  it("is HMAC-SHA256 over the body followed by the decimal timestamp, hex", () => {
    const want = createHmac("sha256", "s3cret").update(Buffer.concat([Buffer.from(body), Buffer.from(ts)])).digest("hex");
    expect(signMultibaas(body, ts, "s3cret")).toBe(want);
  });

  it("accepts a fresh, correctly signed delivery and nothing else", () => {
    const signature = signMultibaas(body, ts, "s3cret");
    const check = (o: Partial<Parameters<typeof verifyMultibaasSignature>[0]>) => verifyMultibaasSignature({ body, signature, timestamp: ts, secret: "s3cret", now, ...o });
    expect(check({})).toBe("ok");
    expect(check({ signature: signature.toUpperCase() })).toBe("ok");
    expect(check({ signature: null })).toBe("missing");
    expect(check({ timestamp: null })).toBe("missing");
    expect(check({ secret: "other" })).toBe("bad-signature");
    expect(check({ body: new TextEncoder().encode("[]") })).toBe("bad-signature");
    expect(check({ signature: "zz" })).toBe("bad-signature");
    expect(check({ now: now + WEBHOOK_TOLERANCE_SEC + 1 })).toBe("stale");
    expect(check({ now: now - WEBHOOK_TOLERANCE_SEC - 1 })).toBe("stale");
    expect(check({ timestamp: "12abc" })).toBe("stale");
    // A timestamp moved inside the window no longer matches its signature.
    expect(check({ timestamp: String(now + 1) })).toBe("bad-signature");
  });
});

describe("parseEmitted", () => {
  it("keys an emitted event by its log and reads removed from rawFields", () => {
    const d = settledDelivery(VAULT, { card: 3, tx: `0x${"AB".repeat(32)}`, logIndex: 26 });
    expect(parseEmitted(d)).toMatchObject({ key: `0x${"ab".repeat(32)}:26`, name: "AuctionSettled", contract: VAULT.toLowerCase(), removed: false, args: { id: "3", graduated: true } });
    expect(parseEmitted(settledDelivery(VAULT, { card: 3, removed: true }))!.removed).toBe(true);
    expect(parseEmitted({ id: "x", event: "transaction.included", data: {} })).toBeNull();
    expect(parseEmitted({ id: "x", event: "event.emitted", data: { nope: 1 } })).toBeNull();
  });

  it("has no key without rawFields.logIndex (indexInLog is no stand-in), and takes a numeric one", () => {
    expect(parseEmitted(settledDelivery(VAULT, { card: 3, logIndex: null }))!.key).toBeNull();
    const d = settledDelivery(VAULT, { card: 3, tx: `0x${"ab".repeat(32)}` });
    const data = d.data as { event: { rawFields: string } };
    data.event.rawFields = JSON.stringify({ ...JSON.parse(data.event.rawFields), logIndex: 7 });
    expect(parseEmitted(d)!.key).toBe(`0x${"ab".repeat(32)}:7`);
    data.event.rawFields = "not json";
    expect(parseEmitted(d)!.key).toBeNull();
  });
});

describe("readCappedBody", () => {
  const stream = (chunks: number[], pulled: { n: number; cancelled: boolean }) =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        const size = chunks[pulled.n++];
        if (size === undefined) c.close();
        else c.enqueue(new Uint8Array(size).fill(65));
      },
      cancel() { pulled.cancelled = true; },
    });
  const req = (body: ReadableStream<Uint8Array> | null, contentLength?: string) =>
    ({ headers: new Headers(contentLength === undefined ? {} : { "content-length": contentLength }), body }) as unknown as Request;

  it("reads a body up to the cap", async () => {
    const pulled = { n: 0, cancelled: false };
    expect((await readCappedBody(req(stream([10, 20], pulled))))!.byteLength).toBe(30);
    expect((await readCappedBody(req(null)))!.byteLength).toBe(0);
    expect((await readCappedBody(req(stream([MAX_WEBHOOK_BODY_BYTES], { n: 0, cancelled: false }), String(MAX_WEBHOOK_BODY_BYTES))))!.byteLength).toBe(MAX_WEBHOOK_BODY_BYTES);
  });

  it("refuses a declared oversize body without reading it", async () => {
    const body = stream([10], { n: 0, cancelled: false });
    expect(await readCappedBody(req(body, String(MAX_WEBHOOK_BODY_BYTES + 1)))).toBeNull();
    expect(await readCappedBody(req(body, "lots"))).toBeNull();
    // Never locked: nothing was read from it.
    expect(body.locked).toBe(false);
  });

  it("stops reading an undeclared (or understated) body at the first chunk past the cap", async () => {
    const half = MAX_WEBHOOK_BODY_BYTES / 2;
    const pulled = { n: 0, cancelled: false };
    expect(await readCappedBody(req(stream([half, half, 1, half, half], pulled)))).toBeNull();
    expect(pulled).toEqual({ n: 3, cancelled: true });
    expect(await readCappedBody(req(stream([half, half, 1], { n: 0, cancelled: false }), "10"))).toBeNull();
  });
});

describe("processDeliveries", () => {
  let published: bigint[];
  let invalidated: number;
  const deps = (over: Partial<WebhookDeps> = {}): WebhookDeps => ({
    vault: VAULT,
    claim: claimDelivery,
    finish: finishDelivery,
    publish: async (id) => { published.push(id); return "written"; },
    invalidate: () => { invalidated++; },
    ...over,
  });
  const rows = () => getDb().select().from(multibaasDeliveries);

  beforeEach(async () => {
    await createTestDb();
    published = [];
    invalidated = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("publishes a graduated settle once, however often and in whatever order it arrives", async () => {
    const a = settledDelivery(VAULT, { card: 1 });
    const b = settledDelivery(VAULT, { card: 2 });
    expect(await processDeliveries([b, a], deps())).toEqual({ retry: false, results: [{ id: b.id, outcome: "written" }, { id: a.id, outcome: "written" }] });
    // MultiBaas redelivers card 1's log under a new id, and a captured delivery for card 2 is replayed as is.
    const again = await processDeliveries([settledDelivery(VAULT, { card: 1, id: "retry-1" }), b], deps());
    expect(again.results.map((r) => r.outcome)).toEqual(["duplicate", "duplicate"]);
    expect(published).toEqual([2n, 1n]);
  });

  it("records a settle that did not graduate without publishing", async () => {
    const d = settledDelivery(VAULT, { card: 5, graduated: false });
    expect((await processDeliveries([d], deps())).results).toEqual([{ id: d.id, outcome: "not-graduated" }]);
    expect(published).toEqual([]);
    expect((await rows()).map((r) => [r.cardId, r.status, r.outcome])).toEqual([[5n, "done", "not-graduated"]]);
  });

  it("ignores other events, other contracts, other kinds and reorged logs, claiming nothing", async () => {
    const out = await processDeliveries([
      settledDelivery(VAULT, { card: 1, name: "CardSharded" }),
      settledDelivery("0x0000000000000000000000000000000000000001", { card: 1 }),
      { id: "tx", event: "transaction.included", data: {} },
      settledDelivery(VAULT, { card: 1, removed: true }),
    ], deps());
    expect(out.results.map((r) => r.outcome)).toEqual(["ignored", "ignored", "ignored", "removed"]);
    expect(await rows()).toEqual([]);
    expect(published).toEqual([]);
  });

  it("invalidates the dashboard's MultiBaas figures once per POST holding a CardVault event, and only then", async () => {
    await processDeliveries([settledDelivery(VAULT, { card: 1 }), settledDelivery(VAULT, { card: 2, name: "FeeAccrued" })], deps());
    expect(invalidated).toBe(1);
    await processDeliveries([settledDelivery(VAULT, { card: 1, removed: true })], deps());
    expect(invalidated).toBe(2);
    await processDeliveries([settledDelivery("0x0000000000000000000000000000000000000001", { card: 1 }), { id: "tx", event: "transaction.included", data: {} }], deps());
    expect(invalidated).toBe(2);
    // A throwing invalidate never fails the delivery.
    const out = await processDeliveries([settledDelivery(VAULT, { card: 3 })], deps({ invalidate: () => { throw new Error("boom"); } }));
    expect(out).toEqual({ retry: false, results: [{ id: "delivery-3-3", outcome: "written" }] });
  });

  it("ignores items of a batch that are not deliveries and handles the rest", async () => {
    const good = settledDelivery(VAULT, { card: 1 });
    const out = await processDeliveries([42, null, { id: "no-event" }, { id: 7, event: "event.emitted" }, { id: "x".repeat(300), event: "event.emitted" }, good], deps());
    expect(out).toEqual({
      retry: false,
      results: [
        { id: "#0", outcome: "ignored" },
        { id: "#1", outcome: "ignored" },
        { id: "no-event", outcome: "ignored" },
        { id: "#3", outcome: "ignored" },
        { id: "x".repeat(200), outcome: "ignored" },
        { id: good.id, outcome: "written" },
      ],
    });
    expect(published).toEqual([1n]);
  });

  it("skips a settle without rawFields.logIndex as malformed, claiming nothing", async () => {
    const d = settledDelivery(VAULT, { card: 2, logIndex: null });
    expect((await processDeliveries([d], deps())).results).toEqual([{ id: d.id, outcome: "malformed" }]);
    expect(await rows()).toEqual([]);
    expect(published).toEqual([]);
  });

  it("starts no appraisal past the deadline and records the rest deferred", async () => {
    let clock = 1_000;
    const slow = deps({ now: () => clock, deadline: 1_000 + 15_000, publish: async (id) => { published.push(id); clock += 10_000; return "written"; } });
    const out = await processDeliveries([1, 2, 3, 4].map((card) => settledDelivery(VAULT, { card })), slow);
    expect(out).toMatchObject({ retry: false });
    expect(out.results.map((r) => r.outcome)).toEqual(["written", "written", "deferred", "deferred"]);
    expect(published).toEqual([1n, 2n]);
    expect((await rows()).filter((r) => r.outcome === "deferred").map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("marks a failed publish for redelivery and publishes on the retry", async () => {
    const d = settledDelivery(VAULT, { card: 9 });
    const failing = deps({ publish: async () => { throw new Error("indexer down"); } });
    expect(await processDeliveries([d], failing)).toEqual({ retry: true, results: [{ id: d.id, outcome: "error" }] });
    expect((await rows())[0]).toMatchObject({ status: "failed" });
    expect(await processDeliveries([d], deps())).toEqual({ retry: false, results: [{ id: d.id, outcome: "written" }] });
    expect((await getDb().select().from(multibaasDeliveries).where(eq(multibaasDeliveries.cardId, 9n)))[0]).toMatchObject({ status: "done", attempts: 2 });
  });

  it("lets a stale handler finish without overwriting the claim that took over its log", async () => {
    const d = settledDelivery(VAULT, { card: 8 });
    let second: Awaited<ReturnType<typeof processDeliveries>> | undefined;
    const takeOver = async () => {
      second = await processDeliveries([settledDelivery(VAULT, { card: 8, id: "redelivered" })], deps());
    };
    // The first handler's publish outlives DELIVERY_STALE_SEC; a redelivery takes the log over and publishes it meanwhile.
    const slow = deps({
      publish: async (id) => {
        await getDb().update(multibaasDeliveries).set({ updatedAt: new Date(Date.now() - (DELIVERY_STALE_SEC + 60) * 1000) }).where(eq(multibaasDeliveries.cardId, id));
        await takeOver();
        throw new Error("rpc timeout");
      },
    });
    expect(await processDeliveries([d], slow)).toMatchObject({ retry: true });
    expect(second).toEqual({ retry: false, results: [{ id: "redelivered", outcome: "written" }] });
    // The stale handler's "failed" was refused: the log stays done, so a further redelivery does nothing.
    expect((await rows())[0]).toMatchObject({ status: "done", outcome: "written", attempts: 2 });
    expect((await processDeliveries([d], deps())).results[0]!.outcome).toBe("duplicate");
    expect(published).toEqual([8n]);
  });

  it("publishes at most MAX_APPRAISALS_PER_REQUEST per delivery and leaves the rest to the daily cron", async () => {
    const many = Array.from({ length: MAX_APPRAISALS_PER_REQUEST + 2 }, (_, i) => settledDelivery(VAULT, { card: i + 1 }));
    const out = await processDeliveries(many, deps());
    expect(out.results.filter((r) => r.outcome === "written")).toHaveLength(MAX_APPRAISALS_PER_REQUEST);
    expect(out.results.filter((r) => r.outcome === "deferred")).toHaveLength(2);
  });

  it("skips a settle whose arguments are not what CardVault emits, and retries when the claim itself fails", async () => {
    const odd = settledDelivery(VAULT, { card: 4, graduated: "yes" });
    expect((await processDeliveries([odd], deps())).results).toEqual([{ id: odd.id, outcome: "malformed" }]);
    const down = deps({ claim: async () => { throw new Error("db down"); } });
    expect(await processDeliveries([settledDelivery(VAULT, { card: 4 })], down)).toMatchObject({ retry: true, results: [{ outcome: "error" }] });
    expect(published).toEqual([]);
  });
});
