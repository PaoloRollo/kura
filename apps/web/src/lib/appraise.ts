import "server-only";
import { and, eq } from "@ponder/client";
import { and as dbAnd, eq as dbEq, type SQL } from "drizzle-orm";
import { parseUnits, type Address, type Hex } from "viem";
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
    const row = await cachedById(quote.source.printingId ?? card.scryfallId).catch(() => null);
    const date = new Date().toISOString().slice(0, 10);
    const column = quote.source.finish === "foil" ? { usdFoil: quote.usd } : quote.source.finish === "nonfoil" ? { usd: quote.usd } : null;
    if (column) await getDb().insert(marketPrices).values({ scryfallId: card.scryfallId, date, ...column }).onConflictDoNothing().catch(() => undefined);
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
};

const db = () => ponderServer().db;

export const defaultDeps: Deps = {
  loadCard: async (id) => ((await db().select().from(t(schema.cards)).where(eq(t(schema.cards.id), id)).limit(1)) as Row<typeof schema.cards>[])[0] ?? null,
  loadSharding: async (token) =>
    ((await db().select().from(t(schema.shardings)).where(eq(t(schema.shardings.shardToken), token)).limit(1)) as Row<typeof schema.shardings>[])[0] ?? null,
  loadEnsNode: async (cardId) =>
    (((await db().select().from(t(schema.ensNames)).where(eq(t(schema.ensNames.cardId), cardId)).limit(1)) as Row<typeof schema.ensNames>[])[0]?.node as Hex | undefined) ?? null,
  loadEnsText: async (node, key) =>
    ((await db().select().from(t(schema.ensRecords)).where(and(eq(t(schema.ensRecords.node), node), eq(t(schema.ensRecords.key), key))).limit(1)) as Row<typeof schema.ensRecords>[])[0]?.value ?? null,
  price: (card, description) => lookupPrice(card, description),
  // One signer, one nonce sequence: writes for different cards queue behind each other.
  writeEnsRecord: (node, usd) => {
    if (process.env.APPRAISER_WRITE_ENS !== "true") return Promise.resolve();
    const run = ensQueue.then(() => writeAppraisalText(node, usd));
    ensQueue = run.catch(() => undefined);
    return run;
  },
};

let ensQueue: Promise<unknown> = Promise.resolve();

async function writeAppraisalText(node: Hex, usd: string) {
  const [{ createWalletClient, http }, { privateKeyToAccount }, { sepolia }, { abi }, { addresses }, { serverEnv }] = await Promise.all([
    import("viem"), import("viem/accounts"), import("viem/chains"), import("@kura/shared"), import("@/lib/chain"), import("@/env"),
  ]);
  const account = privateKeyToAccount(process.env.SIGNER_PRIVATE_KEY as Hex);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(serverEnv().ALCHEMY_HTTP_URL) });
  await wallet.writeContract({ abi: abi.ensResolver, address: addresses.ensResolver, functionName: "setText", args: [node, "appraisal.usd", usd] });
  await wallet.writeContract({ abi: abi.ensResolver, address: addresses.ensResolver, functionName: "setText", args: [node, "appraisal.at", String(Math.floor(Date.now() / 1000))] });
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
}

/** Whether `appraisal.usd` needs writing: a different price, or the same one published over ENS_REWRITE_SEC ago. */
export function needsEnsWrite(current: { usd: string | null; at: number | null }, usd: string, now: number): boolean {
  if (current.usd == null || Number(current.usd) !== Number(usd)) return true;
  return current.at == null || now - current.at >= ENS_REWRITE_SEC;
}

/**
 * Publishes the appraisal on the card's ENS name (appraisal.usd / appraisal.at), deduplicated per card: skipped while a
 * write for the card is in flight, and when neither the indexed record nor this instance's last write needs replacing.
 * Awaited with a short timeout, so a serverless request never leaves the write running unobserved.
 */
async function publishAppraisalRecord(id: bigint, node: Hex, usd: string, deps: Deps) {
  const key = id.toString();
  if (inFlight.has(key)) return;
  const now = Math.floor(Date.now() / 1000);
  const mem = lastWrite.get(key);
  if (mem && !needsEnsWrite(mem, usd, now)) return;
  const [cur, at] = await Promise.all([deps.loadEnsText(node, "appraisal.usd"), deps.loadEnsText(node, "appraisal.at")]).catch(() => [null, null] as const);
  if (!needsEnsWrite({ usd: cur, at: at && /^\d+$/.test(at) ? Number(at) : null }, usd, now)) return;
  const write = deps.writeEnsRecord(node, usd).then(
    () => { lastWrite.set(key, { usd, at: now }); },
    (e) => { console.error("appraise: ENS record write failed", e); },
  ).finally(() => inFlight.delete(key));
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
