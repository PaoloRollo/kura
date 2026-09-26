import { NextResponse } from "next/server";
import { eq } from "@ponder/client";
import { jsonError } from "@/lib/http";
import { marketPriceForCard } from "@/lib/market-price";
import { MAX_CARD_ID } from "@/lib/price-memo";
import { ponderServer, schema } from "@/lib/ponder-server";
import { t, type Row } from "@/lib/ponder-bridge";
import { ScryfallUnavailableError } from "@/lib/scryfall";

type CardRow = Row<typeof schema.cards>;

/** Public: the market price quote for card `id` (lib/pricing's rule), for display. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return jsonError("BAD_REQUEST", "id must be an integer", 400);
  if (BigInt(id) > MAX_CARD_ID) return jsonError("BAD_REQUEST", "id out of range", 400);
  let card: CardRow | undefined;
  try {
    card = ((await ponderServer().db.select().from(t(schema.cards)).where(eq(t(schema.cards.id), BigInt(id))).limit(1)) as CardRow[])[0];
  } catch (e) {
    console.error("price: indexer unavailable", e);
    return jsonError("UNAVAILABLE", "card data is temporarily unavailable", 503);
  }
  if (!card) return jsonError("NOT_FOUND", "unknown card", 404);
  try {
    const quote = await marketPriceForCard(card);
    if (!quote) return jsonError("NOT_FOUND", "card data unavailable", 404);
    return NextResponse.json(quote, { headers: { "cache-control": "public, max-age=300, s-maxage=300" } });
  } catch (e) {
    // Scryfall down, or the indexer failing on the description lookup.
    if (!(e instanceof ScryfallUnavailableError)) console.error("price: lookup failed", e);
    return jsonError("UNAVAILABLE", "prices are temporarily unavailable", 503);
  }
}
