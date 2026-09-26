import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { baseUnits, flag } from "@/lib/multibaas/figures";

/**
 * A delivery's X-MultiBaas-Timestamp may be this far from now, either way. Older is a replay, refused before the
 * body is read; inside the window a replayed log is caught by the claim in app.multibaas_deliveries.
 */
export const WEBHOOK_TOLERANCE_SEC = 600;

export type SignatureCheck = "ok" | "missing" | "stale" | "bad-signature";

/** MultiBaas's signature: hex HMAC-SHA256 with the webhook secret over the raw body followed by the timestamp (docs.curvegrid.com/multibaas/webhooks). */
export function signMultibaas(body: Uint8Array, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(body).update(timestamp).digest("hex");
}

export function verifyMultibaasSignature(p: { body: Uint8Array; signature: string | null; timestamp: string | null; secret: string; now: number }): SignatureCheck {
  if (!p.signature || !p.timestamp) return "missing";
  if (!/^\d{1,12}$/.test(p.timestamp) || Math.abs(p.now - Number(p.timestamp)) > WEBHOOK_TOLERANCE_SEC) return "stale";
  if (!/^[0-9a-fA-F]{64}$/.test(p.signature)) return "bad-signature";
  const want = Buffer.from(signMultibaas(p.body, p.timestamp, p.secret), "hex");
  return timingSafeEqual(Buffer.from(p.signature, "hex"), want) ? "ok" : "bad-signature";
}

/** A POST body larger than this is refused (413) before it is read in full. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * The request body, read up to `max` bytes: null when it is larger, by its Content-Length (nothing read) or by what
 * arrives (the read stops at the first chunk past `max`, so an absent or lying Content-Length can't make it buffer more).
 */
export async function readCappedBody(req: Request, max: number = MAX_WEBHOOK_BODY_BYTES): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return body;
}

const Delivery = z.object({ id: z.string().min(1).max(200), event: z.string(), data: z.unknown() });
/**
 * The POST body: a JSON array. Its items are checked one by one (processDeliveries), so one odd item in a signed batch
 * is ignored instead of refusing (and MultiBaas redelivering) the whole batch.
 */
export const WebhookBody = z.array(z.unknown()).min(1).max(1000);
export type WebhookDelivery = z.infer<typeof Delivery>;

const Emitted = z.object({
  triggeredAt: z.string(),
  event: z.object({
    name: z.string(),
    inputs: z.array(z.object({ name: z.string(), value: z.unknown() }).passthrough()),
    rawFields: z.string().optional(),
    contract: z.object({ address: z.string() }).passthrough(),
    indexInLog: z.number().int().nonnegative(),
  }).passthrough(),
  transaction: z.object({ txHash: z.string(), blockNumber: z.number().int(), blockHash: z.string() }).passthrough(),
}).passthrough();

export type EmittedEvent = {
  /**
   * `${txHash}:${logIndex}`, lower-case: the same log however many times, and under whatever id, it is delivered. Null
   * when rawFields carries no logIndex: indexInLog is not the log's index in its block, so no dedupe key can be made.
   */
  key: string | null;
  deliveryId: string;
  name: string;
  contract: string;
  blockNumber: number;
  /** rawFields.removed: the log was undone by a reorg. */
  removed: boolean;
  args: Record<string, unknown>;
};

/** An event.emitted delivery's event, or null for another kind or an unexpected shape. */
export function parseEmitted(d: WebhookDelivery): EmittedEvent | null {
  if (d.event !== "event.emitted") return null;
  const p = Emitted.safeParse(d.data);
  if (!p.success) return null;
  const { event, transaction } = p.data;
  let raw: { logIndex?: unknown; removed?: unknown } = {};
  try {
    const parsed: unknown = event.rawFields ? JSON.parse(event.rawFields) : {};
    raw = parsed && typeof parsed === "object" ? (parsed as typeof raw) : {};
  } catch {
    raw = {};
  }
  const logIndex =
    typeof raw.logIndex === "string" && /^0x[0-9a-f]{1,8}$/i.test(raw.logIndex) ? Number.parseInt(raw.logIndex, 16)
    : typeof raw.logIndex === "number" && Number.isSafeInteger(raw.logIndex) && raw.logIndex >= 0 ? raw.logIndex
    : null;
  return {
    key: logIndex === null ? null : `${transaction.txHash.toLowerCase()}:${logIndex}`,
    deliveryId: d.id,
    name: event.name,
    contract: event.contract.address.toLowerCase(),
    blockNumber: transaction.blockNumber,
    removed: raw.removed === true,
    args: Object.fromEntries(event.inputs.map((i) => [i.name, i.value])),
  };
}

export type DeliveryResult = { id: string; outcome: string };
export type WebhookDeps = {
  vault: string;
  /** claimDelivery: the claim's token, or null when the log is done or being handled elsewhere. */
  claim: (c: { key: string; deliveryId: string; eventName: string; cardId: bigint | null }) => Promise<number | null>;
  /** finishDelivery: false when the claim (`attempt`) was taken over meanwhile, and nothing was recorded. */
  finish: (key: string, attempt: number, status: "done" | "failed", outcome: string) => Promise<boolean>;
  publish: (cardId: bigint) => Promise<string>;
  /** Drops the dashboard's memoised MultiBaas figures (lib/multibaas/server): called once when a POST held any CardVault event. */
  invalidate?: () => void;
  /** Epoch ms after which no appraisal is started (the rest are "deferred", like past the per-POST cap). */
  deadline?: number;
  now?: () => number;
};

/** ENS writes per POST (each waits up to ENS_WRITE_TIMEOUT_MS); the rest are left to the daily cron. */
export const MAX_APPRAISALS_PER_REQUEST = 5;
/** No appraisal is started this long after the POST began; the rest are left to the daily cron. */
export const WEBHOOK_DEADLINE_MS = 15_000;
const QUIET = new Set(["written", "unchanged", "not-graduated", "disabled"]);

/**
 * Acts on one POST's deliveries. CardVault's AuctionSettled, when the auction graduated, publishes the card's ENS
 * appraisal (`publish`); a non-graduated settle has no clearing to react to and is only recorded (the daily cron still
 * covers the card). Everything else is ignored: other events (CardSharded included: auctions and ShardTokens stay on
 * Ponder), other contracts, other kinds, and removed (reorged) logs. Each acted-on log is claimed once, so duplicated,
 * retried, replayed or out-of-order deliveries publish at most once per log. Any CardVault event (a removed one
 * included: its row leaves MultiBaas's query results) means the dashboard's figures moved, so `invalidate` runs once.
 * Items that are not deliveries are ignored; a settle without a logIndex (no dedupe key) is malformed. Past the per-POST
 * cap or `deadline`, graduated settles are recorded "deferred" and left to the daily cron.
 * `retry`: something threw (the database, the indexer, the RPC); the route answers 503 and MultiBaas redelivers,
 * finished logs being skipped then.
 */
export async function processDeliveries(items: readonly unknown[], deps: WebhookDeps): Promise<{ results: DeliveryResult[]; retry: boolean }> {
  const results: DeliveryResult[] = [];
  const vault = deps.vault.toLowerCase();
  const now = deps.now ?? Date.now;
  let retry = false;
  let vaultEvents = 0;
  let budget = MAX_APPRAISALS_PER_REQUEST;
  for (const [i, item] of items.entries()) {
    const parsed = Delivery.safeParse(item);
    if (!parsed.success) {
      const raw = (item as { id?: unknown } | null)?.id;
      const id = typeof raw === "string" ? raw.slice(0, 200) : `#${i}`;
      console.warn(`multibaas webhook: item ${i} is not a delivery; ignored`);
      results.push({ id, outcome: "ignored" });
      continue;
    }
    const d = parsed.data;
    const ev = parseEmitted(d);
    if (ev && ev.contract === vault) vaultEvents++;
    if (!ev || ev.contract !== vault || ev.name !== "AuctionSettled") {
      results.push({ id: d.id, outcome: "ignored" });
      continue;
    }
    if (ev.removed) {
      console.warn(`multibaas webhook: AuctionSettled ${ev.key ?? d.id} was removed by a reorg; nothing to do (a published appraisal is the market price, still valid)`);
      results.push({ id: d.id, outcome: "removed" });
      continue;
    }
    const key = ev.key;
    if (key === null) {
      console.error(`multibaas webhook: AuctionSettled in ${d.id} has no rawFields.logIndex, so it can't be deduplicated; skipped`);
      results.push({ id: d.id, outcome: "malformed" });
      continue;
    }
    let cardId: bigint;
    let graduated: boolean;
    try {
      cardId = baseUnits(ev.args.id, "id");
      graduated = flag(ev.args.graduated, "graduated");
    } catch (e) {
      console.error(`multibaas webhook: AuctionSettled ${key} has unexpected arguments (${(e as Error).message}); skipped`);
      results.push({ id: d.id, outcome: "malformed" });
      continue;
    }
    let token: number | null;
    try {
      token = await deps.claim({ key, deliveryId: ev.deliveryId, eventName: ev.name, cardId });
    } catch (e) {
      console.error(`multibaas webhook: could not claim ${key}; MultiBaas will redeliver`, e);
      retry = true;
      results.push({ id: d.id, outcome: "error" });
      continue;
    }
    if (token === null) {
      results.push({ id: d.id, outcome: "duplicate" });
      continue;
    }
    try {
      let outcome: string;
      if (!graduated) outcome = "not-graduated";
      else if (budget > 0 && (deps.deadline === undefined || now() < deps.deadline)) {
        budget--;
        outcome = await deps.publish(cardId);
      } else outcome = "deferred";
      if (outcome === "deferred") console.warn(`multibaas webhook: card ${cardId}'s appraisal left for the daily cron (${budget > 0 ? "past the POST's deadline" : `over ${MAX_APPRAISALS_PER_REQUEST} in one POST`})`);
      else if (!QUIET.has(outcome)) console.warn(`multibaas webhook: card ${cardId}'s appraisal: ${outcome}`);
      if (!(await deps.finish(key, token, "done", outcome))) console.warn(`multibaas webhook: ${key}'s claim was taken over before it finished (${outcome}); the newer claim records the outcome`);
      results.push({ id: d.id, outcome });
    } catch (e) {
      console.error(`multibaas webhook: card ${cardId}'s appraisal failed; MultiBaas will redeliver`, e);
      await deps.finish(key, token, "failed", "error").catch(() => undefined);
      retry = true;
      results.push({ id: d.id, outcome: "error" });
    }
  }
  if (vaultEvents > 0 && deps.invalidate) {
    try {
      deps.invalidate();
    } catch (e) {
      console.error("multibaas webhook: could not invalidate the dashboard's MultiBaas figures", e);
    }
  }
  return { results, retry };
}
