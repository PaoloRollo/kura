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

const Delivery = z.object({ id: z.string().min(1).max(200), event: z.string(), data: z.unknown() });
/** The POST body: a JSON array of deliveries. */
export const WebhookBody = z.array(Delivery).min(1).max(200);
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
  /** `${txHash}:${logIndex}`, lower-case: the same log however many times, and under whatever id, it is delivered. */
  key: string;
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
  const logIndex = typeof raw.logIndex === "string" && /^0x[0-9a-f]+$/i.test(raw.logIndex) ? Number.parseInt(raw.logIndex, 16) : event.indexInLog;
  return {
    key: `${transaction.txHash.toLowerCase()}:${logIndex}`,
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
};

/** ENS writes per POST (each waits up to ENS_WRITE_TIMEOUT_MS); the rest are left to the daily cron. */
export const MAX_APPRAISALS_PER_REQUEST = 5;
const QUIET = new Set(["written", "unchanged", "not-graduated", "disabled"]);

/**
 * Acts on one POST's deliveries. CardVault's AuctionSettled, when the auction graduated, publishes the card's ENS
 * appraisal (`publish`); a non-graduated settle has no clearing to react to and is only recorded (the daily cron still
 * covers the card). Everything else is ignored: other events (CardSharded included: auctions and ShardTokens stay on
 * Ponder), other contracts, other kinds, and removed (reorged) logs. Each acted-on log is claimed once, so duplicated,
 * retried, replayed or out-of-order deliveries publish at most once per log. Any CardVault event (a removed one
 * included: its row leaves MultiBaas's query results) means the dashboard's figures moved, so `invalidate` runs once.
 * `retry`: something threw (the database, the indexer, the RPC); the route answers 503 and MultiBaas redelivers,
 * finished logs being skipped then.
 */
export async function processDeliveries(deliveries: readonly WebhookDelivery[], deps: WebhookDeps): Promise<{ results: DeliveryResult[]; retry: boolean }> {
  const results: DeliveryResult[] = [];
  const vault = deps.vault.toLowerCase();
  let retry = false;
  let vaultEvents = 0;
  let budget = MAX_APPRAISALS_PER_REQUEST;
  for (const d of deliveries) {
    const ev = parseEmitted(d);
    if (ev && ev.contract === vault) vaultEvents++;
    if (!ev || ev.contract !== vault || ev.name !== "AuctionSettled") {
      results.push({ id: d.id, outcome: "ignored" });
      continue;
    }
    if (ev.removed) {
      console.warn(`multibaas webhook: AuctionSettled ${ev.key} was removed by a reorg; nothing to do (a published appraisal is the market price, still valid)`);
      results.push({ id: d.id, outcome: "removed" });
      continue;
    }
    let cardId: bigint;
    let graduated: boolean;
    try {
      cardId = baseUnits(ev.args.id, "id");
      graduated = flag(ev.args.graduated, "graduated");
    } catch (e) {
      console.error(`multibaas webhook: AuctionSettled ${ev.key} has unexpected arguments (${(e as Error).message}); skipped`);
      results.push({ id: d.id, outcome: "malformed" });
      continue;
    }
    let token: number | null;
    try {
      token = await deps.claim({ key: ev.key, deliveryId: ev.deliveryId, eventName: ev.name, cardId });
    } catch (e) {
      console.error(`multibaas webhook: could not claim ${ev.key}; MultiBaas will redeliver`, e);
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
      else if (budget > 0) {
        budget--;
        outcome = await deps.publish(cardId);
      } else outcome = "deferred";
      if (outcome === "deferred") console.warn(`multibaas webhook: card ${cardId}'s appraisal left for the daily cron (over ${MAX_APPRAISALS_PER_REQUEST} in one POST)`);
      else if (!QUIET.has(outcome)) console.warn(`multibaas webhook: card ${cardId}'s appraisal: ${outcome}`);
      if (!(await deps.finish(ev.key, token, "done", outcome))) console.warn(`multibaas webhook: ${ev.key}'s claim was taken over before it finished (${outcome}); the newer claim records the outcome`);
      results.push({ id: d.id, outcome });
    } catch (e) {
      console.error(`multibaas webhook: card ${cardId}'s appraisal failed; MultiBaas will redeliver`, e);
      await deps.finish(ev.key, token, "failed", "error").catch(() => undefined);
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
