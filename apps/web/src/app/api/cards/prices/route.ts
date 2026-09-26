import { NextResponse } from "next/server";
import { inArray } from "@ponder/client";
import { jsonError } from "@/lib/http";
import { marketPriceForCard } from "@/lib/market-price";
import { ponderServer, schema } from "@/lib/ponder-server";
import { t, type Row } from "@/lib/ponder-bridge";
import type { PriceQuote } from "@/lib/pricing";

type CardRow = Row<typeof schema.cards>;

/** Most ids one request may ask for. */
export const MAX_IDS = 100;
/** Price lookups in flight at once (each is a Scryfall read plus a description lookup). */
const CONCURRENCY = 4;

async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Public: market price quotes (lib/pricing's rule, as /api/cards/[id]/price) for up to 100 cards,
 * `?ids=1,2,3` → `{ "1": PriceQuote | null, ... }`. Null for an unknown card, a card without a price, or a failed lookup.
 */
export async function GET(req: Request) {
  const raw = (new URL(req.url).searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.some((s) => !/^\d+$/.test(s))) return jsonError("BAD_REQUEST", "ids must be comma-separated integers", 400);
  const ids = [...new Set(raw.map((s) => BigInt(s).toString()))];
  if (ids.length > MAX_IDS) return jsonError("BAD_REQUEST", `at most ${MAX_IDS} ids`, 400);
  if (ids.length === 0) return NextResponse.json({});
  let cards: CardRow[];
  try {
    cards = (await ponderServer().db.select().from(t(schema.cards)).where(inArray(t(schema.cards.id), ids.map(BigInt)))) as CardRow[];
  } catch (e) {
    console.error("prices: indexer unavailable", e);
    return jsonError("UNAVAILABLE", "card data is temporarily unavailable", 503);
  }
  const byId = new Map(cards.map((c) => [c.id.toString(), c]));
  const quotes = await mapBounded(ids, CONCURRENCY, async (id): Promise<PriceQuote | null> => {
    const card = byId.get(id);
    if (!card) return null;
    return marketPriceForCard(card).catch((e) => {
      console.error(`prices: lookup failed for card ${id}`, e);
      return null;
    });
  });
  return NextResponse.json(Object.fromEntries(ids.map((id, i) => [id, quotes[i]])), { headers: { "cache-control": "public, max-age=300, s-maxage=300" } });
}
