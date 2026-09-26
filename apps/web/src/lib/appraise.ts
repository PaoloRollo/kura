import "server-only";
import { and, eq } from "@ponder/client";
import { and as dbAnd, eq as dbEq, sql, type SQL } from "drizzle-orm";
import { encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { TTL, q96ToUsdcPerShard, type Appraisal } from "@kura/shared";
import { getDb } from "@/lib/db/client";
import { appraisals, marketPrices, scryfallCache } from "@/lib/db/schema";
import { HttpError } from "@/lib/http";
import { ponderServer, schema } from "@/lib/ponder-server";
import { t, type Row } from "@/lib/ponder-bridge";
import { finishOf, priceSourceLabel, quoteMarketPrice, type PriceQuote, type PrintingPrices } from "@/lib/pricing";
import { marketPriceForCard } from "@/lib/market-price";
import { ScryfallUnavailableError, scryfall as sharedScryfall, type Scryfall, type ScryfallCard } from "@/lib/scryfall";
import { nowSec, signAppraisal } from "@/lib/signer";

/** floor(price × 1e6 / shards): USDC (6 decimals) per whole shard for a whole-card price in dollars. */
export function computeUsdcPerShard(priceUsd: string, totalShards: number): bigint {
  return parseUnits(priceUsd, 6) / BigInt(totalShards);
}

export type PriceSource = "scryfall" | "snapshot";
/** A priced card: the quote (lib/pricing's rule), whether it came live or from the cache, and when it was fetched (unix s). */
export type PriceLookup = { quote: PriceQuote | null; source: PriceSource | null; pricedAt: number | null };

/** A cached price older than this is no price at all: the appraisal answers NO_PRICE instead. */
export const SNAPSHOT_MAX_AGE_SEC = 7 * 24 * 60 * 60;

type CachedPrinting = { card: ScryfallCard; fetchedAt: Date };

/** A cached printing whatever its age (the fallback while Scryfall is rate limiting or down). */
async function cached(where: SQL): Promise<CachedPrinting | null> {
  const rows = await getDb().select({ raw: scryfallCache.raw, fetchedAt: scryfallCache.fetchedAt }).from(scryfallCache).where(where).limit(1);
  return rows[0] ? { card: rows[0].raw as ScryfallCard, fetchedAt: rows[0].fetchedAt } : null;
}
const cachedById = (id: string) => cached(dbEq(scryfallCache.scryfallId, id));
const cachedPrinting = (set: string, number: string, lang: string) =>
  cached(dbAnd(dbEq(scryfallCache.setCode, set), dbEq(scryfallCache.collectorNumber, number), dbEq(scryfallCache.lang, lang))!);

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * The card's price for an appraisal: `marketPriceForCard` (the card page's rule, one finish rule) through the shared
 * Scryfall client, `pricedAt` being when the priced printing was fetched. While Scryfall is unavailable, the last cached
 * printing up to SNAPSHOT_MAX_AGE_SEC old, labelled "snapshot"; older than that, no price.
 */
export async function lookupPrice(card: { id: bigint; scryfallId: string; condition: string }, description: string | null, client: Scryfall = sharedScryfall()): Promise<PriceLookup> {
  const nowS = Math.floor(Date.now() / 1000);
  try {
    const quote = await marketPriceForCard(card, client, { description });
    if (!quote?.usd) return { quote, source: null, pricedAt: null };
    // The price is the priced printing's (the English one on a fallback), so it is recorded under that printing's id.
    const printingId = quote.source.printingId ?? card.scryfallId;
    const row = await cachedById(printingId).catch(() => null);
    const date = new Date().toISOString().slice(0, 10);
    const f = quote.source.finish;
    const column = f === "foil" ? { usdFoil: quote.usd } : f === "etched" ? { usdEtched: quote.usd } : { usd: quote.usd };
    await getDb().insert(marketPrices).values({ scryfallId: printingId, date, ...column }).onConflictDoNothing().catch(() => undefined);
    return { quote, source: "scryfall", pricedAt: row ? sec(row.fetchedAt) : nowS };
  } catch (e) {
    if (!(e instanceof ScryfallUnavailableError)) throw e;
  }
  const own = await cachedById(card.scryfallId);
  if (!own) return { quote: null, source: null, pricedAt: null };
  let pricedAt = sec(own.fetchedAt);
  const quote = await quoteMarketPrice({
    printing: own.card as PrintingPrices,
    finish: finishOf(description, own.card),
    condition: card.condition,
    englishPrinting: async (set, number) => {
      const en = await cachedPrinting(set, number, "en");
      if (en) pricedAt = sec(en.fetchedAt);
      return en?.card ?? null;
    },
  });
  if (!quote.usd || nowS - pricedAt > SNAPSHOT_MAX_AGE_SEC) return { quote: null, source: null, pricedAt: null };
  return { quote, source: "snapshot", pricedAt };
}

type CardRow = { id: bigint; scryfallId: string; condition: string; shardToken: Address | null; state: string };
type ShardingRow = {
  shardToken: Address;
  cardId: bigint;
  totalShards: number;
  settled: boolean;
  redeemer: Address | null;
  /** Null when the auction did not graduate; the vault still prices the buyout at clearingPriceQ96. */
  clearingUsdcPerShard: bigint | null;
  clearingPriceQ96: bigint | null;
};

export type Deps = {
  loadCard: (id: bigint) => Promise<CardRow | null>;
  loadSharding: (shardToken: Address) => Promise<ShardingRow | null>;
  loadEnsNode: (cardId: bigint) => Promise<Hex | null>;
  loadEnsText: (node: Hex, key: string) => Promise<string | null>;
  price: (card: CardRow, description: string | null) => Promise<PriceLookup>;
  writeEnsRecord: (node: Hex, usd: string) => Promise<void>;
  /** APPRAISER_WRITE_ENS: whether appraisals are published on the card's ENS name at all. */
  ensWritesEnabled: () => boolean;
  /**
   * Runs `fn` holding the card's cross-instance write lock; false (and `fn` not run) when another instance holds it.
   * See pgEnsWriteLock.
   */
  ensWriteLock: (cardId: bigint, fn: () => Promise<void>) => Promise<boolean>;
};

const db = () => ponderServer().db;

// One signer, one nonce sequence: all of this instance's ENS writes queue behind each other (other instances:
// sendWithFreshNonce). A caller reserves its turn synchronously, before any await, so a write queued behind another
// holds no DB connection while it waits — see pgEnsWriteLock.
let ensQueue: Promise<void> = Promise.resolve();

/**
 * The card's ENS write lock across serverless instances: enters the in-process write queue first, so a write queued
 * behind another holds no DB connection while it waits its turn. Once it is this call's turn, `pg_try_advisory_xact_lock`
 * is taken in a short transaction holding only the lock check — committed (and the lock released) before `fn` (the
 * chain send) runs, never around it. False (and `fn` not run) when another instance holds the lock.
 */
export async function pgEnsWriteLock(cardId: bigint, fn: () => Promise<void>): Promise<boolean> {
  const turn = ensQueue;
  let releaseTurn!: () => void;
  ensQueue = new Promise<void>((resolve) => { releaseTurn = resolve; });
  await turn.catch(() => undefined);
  try {
    const locked = await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local idle_in_transaction_session_timeout = '60s'`);
      const res = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext('appraisal-ens:' || ${cardId.toString()})) as locked`);
      // postgres-js answers the rows, PGlite (tests) an object holding them.
      const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as { locked: boolean }[];
      return !!rows[0]?.locked;
    });
    if (!locked) return false;
    await fn();
    return true;
  } finally {
    releaseTurn();
  }
}

export const defaultDeps: Deps = {
  loadCard: async (id) => ((await db().select().from(t(schema.cards)).where(eq(t(schema.cards.id), id)).limit(1)) as Row<typeof schema.cards>[])[0] ?? null,
  loadSharding: async (token) =>
    ((await db().select().from(t(schema.shardings)).where(eq(t(schema.shardings.shardToken), token)).limit(1)) as Row<typeof schema.shardings>[])[0] ?? null,
  loadEnsNode: async (cardId) =>
    (((await db().select().from(t(schema.ensNames)).where(eq(t(schema.ensNames.cardId), cardId)).limit(1)) as Row<typeof schema.ensNames>[])[0]?.node as Hex | undefined) ?? null,
  loadEnsText: async (node, key) =>
    ((await db().select().from(t(schema.ensRecords)).where(and(eq(t(schema.ensRecords.node), node), eq(t(schema.ensRecords.key), key))).limit(1)) as Row<typeof schema.ensRecords>[])[0]?.value ?? null,
  price: (card, description) => lookupPrice(card, description),
  writeEnsRecord: (node, usd) => writeAppraisalText(node, usd),
  ensWritesEnabled: () => process.env.APPRAISER_WRITE_ENS === "true",
  ensWriteLock: pgEnsWriteLock,
};

const NONCE_ERROR = /nonce too (low|high)|replacement transaction underpriced|already known/i;

/**
 * name/shortMessage/details across an error and its causes — never `.message`: viem's formatted message always dumps
 * the request arguments (the nonce included), so matching on it would retry every failure, an RPC timeout after the
 * node already accepted the transaction included.
 */
function errorSignals(e: unknown): string {
  const parts: string[] = [];
  for (let cur = e, i = 0; cur && i < 5; cur = (cur as { cause?: unknown }).cause, i++) {
    const x = cur as { name?: string; shortMessage?: string; details?: string };
    parts.push(x.name ?? "", x.shortMessage ?? "", x.details ?? "");
  }
  return parts.join(" ");
}

/**
 * Sends a transaction with the signer's pending nonce read from the chain (other instances share the key, so a local
 * nonce counter would collide), and once more with a fresh nonce if the node refuses it as a nonce or replacement clash.
 */
export async function sendWithFreshNonce(send: (nonce: number) => Promise<Hex>, pendingNonce: () => Promise<number>): Promise<Hex> {
  try {
    return await send(await pendingNonce());
  } catch (e) {
    if (!NONCE_ERROR.test(errorSignals(e))) throw e;
    console.warn("appraise: nonce clash on the ENS write, retrying once with a fresh nonce");
    return send(await pendingNonce());
  }
}

/** Both records in one resolver multicall (one transaction, one nonce), sent with the chain's pending nonce. */
async function writeAppraisalText(node: Hex, usd: string) {
  const [{ createWalletClient, createPublicClient, http }, { privateKeyToAccount }, { sepolia }, { abi }, { addresses }, { serverEnv }] = await Promise.all([
    import("viem"), import("viem/accounts"), import("viem/chains"), import("@kura/shared"), import("@/lib/chain"), import("@/env"),
  ]);
  const account = privateKeyToAccount(process.env.SIGNER_PRIVATE_KEY as Hex);
  const transport = http(serverEnv().ALCHEMY_HTTP_URL);
  const wallet = createWalletClient({ account, chain: sepolia, transport });
  const reader = createPublicClient({ chain: sepolia, transport });
  const calls = [
    encodeFunctionData({ abi: abi.ensResolver, functionName: "setText", args: [node, "appraisal.usd", usd] }),
    encodeFunctionData({ abi: abi.ensResolver, functionName: "setText", args: [node, "appraisal.at", String(Math.floor(Date.now() / 1000))] }),
  ];
  await sendWithFreshNonce(
    (nonce) => wallet.writeContract({ abi: abi.ensResolver, address: addresses.ensResolver, functionName: "multicall", args: [calls], nonce }),
    () => reader.getTransactionCount({ address: account.address, blockTag: "pending" }),
  );
}

export type AppraiseResult = {
  appraisal: { cardId: string; shardToken: Address; usdcPerShard: string; expiresAt: string };
  signature: Hex;
  /** Scryfall USD for the whole card, before the condition multiplier. */
  marketUsd: string;
  /** marketUsd × the condition multiplier: what the appraisal divides by the shard count. */
  adjustedUsd: string;
  conditionMultiplier: number;
  /** "Scryfall USD · nonfoil · EN printing · NM ×1.00" */
  priceSource: string;
  source: PriceSource;
  /** When the price was fetched (unix s): now for a live price, the cache time for a snapshot. */
  pricedAt: number | null;
  /** The auction's clearing price per shard, from clearingPriceQ96 even when the auction did not graduate. */
  clearingUsdcPerShard: string;
};

/** Re-publish `appraisal.usd` only when the price changed or the record is at least this old. */
export const ENS_REWRITE_SEC = 60 * 60;
/** How long a request waits for the ENS write before answering anyway (the write is logged, never retried here). */
export const ENS_WRITE_TIMEOUT_MS = 5_000;

// Per card: the last value written by this instance (the indexer lags a fresh write) and the write in flight.
const lastWrite = new Map<string, { usd: string; at: number }>();
const inFlight = new Map<string, Promise<void>>();
export function resetAppraisalWritesForTests() {
  lastWrite.clear();
  inFlight.clear();
  recentByDid.clear();
}

/** Whether `appraisal.usd` needs writing: a different price, or the same one published over ENS_REWRITE_SEC ago. */
export function needsEnsWrite(current: { usd: string | null; at: number | null }, usd: string, now: number): boolean {
  if (current.usd == null || Number(current.usd) !== Number(usd)) return true;
  return current.at == null || now - current.at >= ENS_REWRITE_SEC;
}

/**
 * Publishes the appraisal on the card's ENS name (appraisal.usd / appraisal.at), deduplicated per card: skipped while a
 * write for the card is in flight here (registered before any await), while another instance holds the card's lock, and
 * when neither the indexed record nor this instance's last write needs replacing. Awaited with a short timeout, so a
 * serverless request never leaves the write running unobserved.
 */
async function publishAppraisalRecord(id: bigint, node: Hex, usd: string, deps: Deps) {
  const key = id.toString();
  if (!deps.ensWritesEnabled() || inFlight.has(key)) return;
  const now = Math.floor(Date.now() / 1000);
  const write = (async () => {
    const mem = lastWrite.get(key);
    if (mem && !needsEnsWrite(mem, usd, now)) return;
    const acquired = await deps.ensWriteLock(id, async () => {
      const [cur, at] = await Promise.all([deps.loadEnsText(node, "appraisal.usd"), deps.loadEnsText(node, "appraisal.at")]).catch(() => [null, null] as const);
      if (!needsEnsWrite({ usd: cur, at: at && /^\d+$/.test(at) ? Number(at) : null }, usd, now)) return;
      await deps.writeEnsRecord(node, usd);
      lastWrite.set(key, { usd, at: now });
    });
    if (!acquired) console.info(`appraise: card ${key}'s ENS write is running on another instance, skipped`);
  })().catch((e) => { console.error("appraise: ENS record write failed", e); }).finally(() => inFlight.delete(key));
  inFlight.set(key, write);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((r) => { timer = setTimeout(() => { console.error(`appraise: ENS write for card ${key} still pending after ${ENS_WRITE_TIMEOUT_MS} ms`); r(); }, ENS_WRITE_TIMEOUT_MS); });
  await Promise.race([write, timeout]);
  clearTimeout(timer);
}

/** Signs a 10-minute appraisal of the card's live sharding at the market price per shard. */
export async function runAppraise(body: { cardId: string }, deps: Deps = defaultDeps): Promise<AppraiseResult> {
  const id = BigInt(body.cardId);
  const card = await deps.loadCard(id);
  if (!card) throw new HttpError("NOT_FOUND", "unknown card", 404);
  if (!card.shardToken) throw new HttpError("NOT_SHARDED", "card has no live sharding", 409);
  const sharding = await deps.loadSharding(card.shardToken);
  if (!sharding || !sharding.settled) throw new HttpError("NOT_SHARDED", "auction not settled", 409);
  if (sharding.redeemer) throw new HttpError("ALREADY_REDEEMED", "card was already redeemed", 409);

  const node = await deps.loadEnsNode(id);
  const description = node ? await deps.loadEnsText(node, "description") : null;
  const { quote, source, pricedAt } = await deps.price(card, description);
  if (!quote?.adjustedUsd || !source) throw new HttpError("NO_PRICE", "No market price available yet, try again later", 400);
  const usdcPerShard = computeUsdcPerShard(quote.adjustedUsd, sharding.totalShards);
  if (usdcPerShard === 0n) throw new HttpError("NO_PRICE", "No market price available yet, try again later", 400);

  const appraisal: Appraisal = { cardId: id, shardToken: card.shardToken, usdcPerShard, expiresAt: nowSec() + BigInt(TTL.appraisalSec) };
  const signature = await signAppraisal(appraisal);
  const label = `${priceSourceLabel(quote, card.condition)}${source === "snapshot" ? " · cached" : ""}`;
  await getDb().insert(appraisals).values({
    id: crypto.randomUUID(), cardId: id, shardToken: card.shardToken, usdcPerShard, marketUsd: quote.usd, priceSource: label,
    conditionMultiplier: String(quote.conditionMultiplier), expiresAt: appraisal.expiresAt, signature,
  });

  if (node) await publishAppraisalRecord(id, node, quote.adjustedUsd, deps);

  return {
    appraisal: { cardId: id.toString(), shardToken: card.shardToken, usdcPerShard: usdcPerShard.toString(), expiresAt: appraisal.expiresAt.toString() },
    signature,
    marketUsd: quote.usd!,
    adjustedUsd: quote.adjustedUsd,
    conditionMultiplier: quote.conditionMultiplier,
    priceSource: label,
    source,
    pricedAt,
    clearingUsdcPerShard: q96ToUsdcPerShard(sharding.clearingPriceQ96 ?? 0n).toString(),
  };
}

/** One signed (and stored) appraisal per DID per this long; a repeat inside it gets the same appraisal back. */
export const APPRAISE_DID_INTERVAL_MS = 10_000;
const recentByDid = new Map<string, { at: number; cardId: string; result: Promise<AppraiseResult> }>();

/**
 * runAppraise throttled per user (DID) in this instance: within APPRAISE_DID_INTERVAL_MS of the last one, the same card
 * answers the same appraisal (still valid for minutes) without signing or storing a new one, another card RATE_LIMITED.
 */
export async function runAppraiseFor(did: string, body: { cardId: string }, deps: Deps = defaultDeps, now = Date.now()): Promise<AppraiseResult> {
  const cardId = BigInt(body.cardId).toString();
  const recent = recentByDid.get(did);
  if (recent && now - recent.at < APPRAISE_DID_INTERVAL_MS) {
    if (recent.cardId === cardId) return recent.result;
    throw new HttpError("RATE_LIMITED", "One appraisal every 10 seconds, try again shortly", 429);
  }
  if (recentByDid.size > 1000) for (const [k, v] of recentByDid) if (now - v.at >= APPRAISE_DID_INTERVAL_MS) recentByDid.delete(k);
  const result = runAppraise(body, deps);
  recentByDid.set(did, { at: now, cardId, result });
  // A failed attempt doesn't count against the user.
  result.catch(() => { if (recentByDid.get(did)?.result === result) recentByDid.delete(did); });
  return result;
}
