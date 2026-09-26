import { NextResponse } from "next/server";
import { asc, eq as eqApp } from "drizzle-orm";
import { eq } from "@ponder/client";
import { getDb } from "@/lib/db/client";
import { marketPrices } from "@/lib/db/schema";
import { jsonError } from "@/lib/http";
import { marketPriceForCard, mintDescription } from "@/lib/market-price";
import { MAX_CARD_ID } from "@/lib/price-memo";
import { applyMultiplier, conditionMultiplier, finishOf, finishPrice } from "@/lib/pricing";
import { ponderServer, schema } from "@/lib/ponder-server";
import { t, type Row } from "@/lib/ponder-bridge";
import { scryfall as sharedScryfall, ScryfallUnavailableError } from "@/lib/scryfall";

type CardRow = Row<typeof schema.cards>;
export type MarketPoint = { date: string; usd: string | null; adjustedUsd: string | null };

/**
 * Public: card `id`'s daily market price history (the cron's `market_prices` snapshots), ascending, priced by
 * lib/pricing's rule: the card's finish, the condition multiplier, and the English printing's rows when that is what
 * the card is priced at. Empty until the first snapshot.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return jsonError("BAD_REQUEST", "id must be an integer", 400);
  if (BigInt(id) > MAX_CARD_ID) return jsonError("BAD_REQUEST", "id out of range", 400);
  let card: CardRow | undefined;
  let description: string | null;
  try {
    card = ((await ponderServer().db.select().from(t(schema.cards)).where(eq(t(schema.cards.id), BigInt(id))).limit(1)) as CardRow[])[0];
    description = card ? await mintDescription(card.id) : null;
  } catch (e) {
    console.error("market: indexer unavailable", e);
    return jsonError("UNAVAILABLE", "card data is temporarily unavailable", 503);
  }
  if (!card) return jsonError("NOT_FOUND", "unknown card", 404);
  try {
    const s = sharedScryfall();
    const printing = await s.getCard(card.scryfallId);
    if (!printing) return jsonError("NOT_FOUND", "card data unavailable", 404);
    const finish = finishOf(description, printing);
    const quote = await marketPriceForCard(card, s, { description });
    const printingId = quote?.source.englishFallback && quote.source.printingId ? quote.source.printingId : card.scryfallId;
    const rows = await getDb().select().from(marketPrices).where(eqApp(marketPrices.scryfallId, printingId)).orderBy(asc(marketPrices.date));
    const m = conditionMultiplier(card.condition);
    const series: MarketPoint[] = rows.map((r) => {
      const usd = finishPrice({ usd: r.usd, usd_foil: r.usdFoil, usd_etched: r.usdEtched }, finish);
      return { date: r.date, usd, adjustedUsd: usd ? applyMultiplier(usd, m) : null };
    });
    return NextResponse.json(series, { headers: { "cache-control": "public, max-age=300, s-maxage=300" } });
  } catch (e) {
    if (!(e instanceof ScryfallUnavailableError)) console.error("market: lookup failed", e);
    return jsonError("UNAVAILABLE", "prices are temporarily unavailable", 503);
  }
}
