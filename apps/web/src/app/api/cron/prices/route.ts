import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { ne } from "@ponder/client";
import { getDb } from "@/lib/db/client";
import { marketPrices } from "@/lib/db/schema";
import { jsonError } from "@/lib/http";
import { marketPriceForCard } from "@/lib/market-price";
import { ponderServer, schema } from "@/lib/ponder-server";
import { t, type Row } from "@/lib/ponder-bridge";
import { scryfall as sharedScryfall, type ScryfallCard } from "@/lib/scryfall";

type CardRow = Row<typeof schema.cards>;

// Within every Vercel plan's limit; a few dozen cards at Scryfall's ~10 req/s take seconds.
export const maxDuration = 60;
/** Stop starting new cards past this, so the run returns before maxDuration kills it. */
export const BUDGET_MS = 50_000;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Daily (vercel.json, 03:00 UTC; Vercel Cron sends `Authorization: Bearer $CRON_SECRET`): today's `market_prices`
 * row for every vault card's printing (cards not released), plus the English printing when that is what the card is
 * priced at (lib/pricing's fallback). One row per printing and UTC day, upserted. Sequential, so Scryfall's rate limit
 * holds; every lookup is `fresh` (past Scryfall's 24h cache), so a snapshot never records yesterday's price.
 * `{ updated, total }`: printings written, cards considered; `partial: true` when the run stopped at BUDGET_MS.
 */
export async function GET(req: Request) {
  const start = Date.now();
  if (!authorized(req)) return jsonError("UNAUTHENTICATED", "bad secret", 401);
  let cards: CardRow[];
  try {
    cards = (await ponderServer().db.select().from(t(schema.cards)).where(ne(t(schema.cards.state), "released"))) as CardRow[];
  } catch (e) {
    console.error("cron prices: indexer unavailable", e);
    return jsonError("UNAVAILABLE", "card data is temporarily unavailable", 503);
  }
  const date = new Date().toISOString().slice(0, 10);
  const s = sharedScryfall();
  const done = new Set<string>();
  const snapshot = async (printing: ScryfallCard | null) => {
    if (!printing || done.has(printing.id)) return;
    const row = { usd: printing.prices.usd ?? null, usdFoil: printing.prices.usd_foil ?? null, usdEtched: printing.prices.usd_etched ?? null, eur: printing.prices.eur ?? null };
    await getDb().insert(marketPrices).values({ scryfallId: printing.id, date, ...row })
      .onConflictDoUpdate({ target: [marketPrices.scryfallId, marketPrices.date], set: row });
    done.add(printing.id);
  };
  const fresh = { fresh: true };
  for (const [i, card] of cards.entries()) {
    const elapsed = Date.now() - start;
    if (elapsed > BUDGET_MS) {
      console.warn(`cron prices: stopped after ${Math.round(elapsed / 1000)}s at card ${i + 1} of ${cards.length}; the rest wait for the next run`);
      return NextResponse.json({ updated: done.size, total: cards.length, partial: true });
    }
    try {
      if (!done.has(card.scryfallId)) await snapshot(await s.getCard(card.scryfallId, fresh));
      const quote = await marketPriceForCard(card, s, fresh);
      const fallback = quote?.source.englishFallback ? quote.source.printingId : null;
      if (fallback && !done.has(fallback)) await snapshot(await s.getCard(fallback, fresh));
    } catch (e) {
      console.error(`cron prices: card ${card.id} failed`, e);
    }
  }
  return NextResponse.json({ updated: done.size, total: cards.length });
}
