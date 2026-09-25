import { NextResponse } from "next/server";
import { eq } from "@ponder/client";
import { jsonError } from "@/lib/http";
import { marketPriceForCard } from "@/lib/market-price";
import { ponderServer, schema } from "@/lib/ponder-server";
import { t, type Row } from "@/lib/ponder-bridge";
import { ScryfallUnavailableError } from "@/lib/scryfall";

/** Public: the market price quote for card `id` (lib/pricing's rule), for display. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return jsonError("BAD_REQUEST", "id must be an integer", 400);
  const rows = (await ponderServer().db.select().from(t(schema.cards)).where(eq(t(schema.cards.id), BigInt(id))).limit(1)) as Row<typeof schema.cards>[];
  const card = rows[0];
  if (!card) return jsonError("NOT_FOUND", "unknown card", 404);
  try {
    const quote = await marketPriceForCard(card);
    if (!quote) return jsonError("NOT_FOUND", "card data unavailable", 404);
    return NextResponse.json(quote, { headers: { "cache-control": "public, max-age=300" } });
  } catch (e) {
    if (e instanceof ScryfallUnavailableError) return jsonError("UNAVAILABLE", "prices are temporarily unavailable", 503);
    throw e;
  }
}
