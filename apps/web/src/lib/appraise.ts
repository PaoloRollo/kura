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
import { finishFromDescription, priceSourceLabel, quoteMarketPrice, type Finish, type PriceQuote, type PrintingPrices } from "@/lib/pricing";
import { ScryfallUnavailableError, scryfall as sharedScryfall, type Scryfall, type ScryfallCard } from "@/lib/scryfall";
import { nowSec, signAppraisal } from "@/lib/signer";

/** floor(price × 1e6 / shards): USDC (6 decimals) per whole shard for a whole-card price in dollars. */
export function computeUsdcPerShard(priceUsd: string, totalShards: number): bigint {
  return parseUnits(priceUsd, 6) / BigInt(totalShards);
}

/**
 * The finish to price (W4): the mint description says foil or etched ("…, foil"); otherwise a printing that has no
 * non-foil finish is priced as the finish it does have. Everything else is non-foil.
 */
export function resolveFinish(description: string | null | undefined, finishes: readonly string[] | undefined): Finish {
  const fromDescription = finishFromDescription(description);
  if (fromDescription !== "nonfoil") return fromDescription;
  if (finishes && finishes.length > 0 && !finishes.includes("nonfoil")) return finishes.includes("foil") ? "foil" : finishes.includes("etched") ? "etched" : "nonfoil";
  return "nonfoil";
}

export type PriceSource = "scryfall" | "snapshot";
/** A priced card: the quote (lib/pricing's rule), whether it came live or from the cache, and when it was fetched (unix s). */
export type PriceLookup = { quote: PriceQuote | null; source: PriceSource | null; pricedAt: number | null };

type PrintingSource = {
  card: (id: string) => Promise<ScryfallCard | null>;
  printing: (set: string, number: string, lang: string) => Promise<ScryfallCard | null>;
};

/** Cached printings regardless of age: the fallback while Scryfall is rate limiting or down. */
async function staleCache(where: SQL): Promise<{ card: ScryfallCard; fetchedAt: Date } | null> {
  const rows = await getDb().select({ raw: scryfallCache.raw, fetchedAt: scryfallCache.fetchedAt }).from(scryfallCache).where(where).limit(1);
  return rows[0] ? { card: rows[0].raw as ScryfallCard, fetchedAt: rows[0].fetchedAt } : null;
}

async function quoteFrom(src: PrintingSource, card: { scryfallId: string; condition: string }, description: string | null) {
  const printing = await src.card(card.scryfallId);
  if (!printing) return null;
  return quoteMarketPrice({
    printing: printing as PrintingPrices,
    finish: resolveFinish(description, printing.finishes),
    condition: card.condition,
    englishPrinting: (set, number) => src.printing(set, number, "en"),
  });
}

/**
 * The card's price for an appraisal. Live through the shared Scryfall client (its 24 h cache first); when Scryfall is
 * unavailable, the last cached printing whatever its age, labelled "snapshot" with when it was fetched.
 */
export async function lookupPrice(card: { scryfallId: string; condition: string }, description: string | null, client: Scryfall = sharedScryfall()): Promise<PriceLookup> {
  try {
    const quote = await quoteFrom({ card: (id) => client.getCard(id), printing: (s, n, l) => client.getPrinting(s, n, l) }, card, description);
    if (quote?.usd) {
      const date = new Date().toISOString().slice(0, 10);
      const column = quote.source.finish === "foil" ? { usdFoil: quote.usd } : quote.source.finish === "nonfoil" ? { usd: quote.usd } : null;
      if (column) await getDb().insert(marketPrices).values({ scryfallId: card.scryfallId, date, ...column }).onConflictDoNothing().catch(() => undefined);
    }
    return { quote, source: quote ? "scryfall" : null, pricedAt: quote ? Math.floor(Date.now() / 1000) : null };
  } catch (e) {
    if (!(e instanceof ScryfallUnavailableError)) throw e;
  }
  let fetchedAt: Date | null = null;
  const src: PrintingSource = {
    card: async (id) => {
      const hit = await staleCache(dbEq(scryfallCache.scryfallId, id));
      fetchedAt = hit?.fetchedAt ?? null;
      return hit?.card ?? null;
    },
    printing: async (set, number, lang) => {
      const rows = await getDb().select({ raw: scryfallCache.raw }).from(scryfallCache)
        .where(dbAnd(dbEq(scryfallCache.setCode, set), dbEq(scryfallCache.collectorNumber, number), dbEq(scryfallCache.lang, lang))).limit(1);
      return (rows[0]?.raw as ScryfallCard | undefined) ?? null;
    },
  };
  const quote = await quoteFrom(src, card, description);
  const at = fetchedAt as Date | null;
  return { quote, source: quote?.usd ? "snapshot" : null, pricedAt: quote?.usd && at ? Math.floor(at.getTime() / 1000) : null };
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
  writeEnsRecord: async (node, usd) => {
    if (process.env.APPRAISER_WRITE_ENS !== "true") return;
    const [{ createWalletClient, http }, { privateKeyToAccount }, { sepolia }, { abi }, { addresses }, { serverEnv }] = await Promise.all([
      import("viem"), import("viem/accounts"), import("viem/chains"), import("@kura/shared"), import("@/lib/chain"), import("@/env"),
    ]);
    const account = privateKeyToAccount(process.env.SIGNER_PRIVATE_KEY as Hex);
    const wallet = createWalletClient({ account, chain: sepolia, transport: http(serverEnv().ALCHEMY_HTTP_URL) });
    await wallet.writeContract({ abi: abi.ensResolver, address: addresses.ensResolver, functionName: "setText", args: [node, "appraisal.usd", usd] });
    await wallet.writeContract({ abi: abi.ensResolver, address: addresses.ensResolver, functionName: "setText", args: [node, "appraisal.at", String(Math.floor(Date.now() / 1000))] });
  },
};

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

  if (node) deps.writeEnsRecord(node, quote.adjustedUsd).catch((e) => console.error("appraise: ENS record write failed", e));

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
