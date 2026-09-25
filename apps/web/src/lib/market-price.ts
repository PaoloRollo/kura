import "server-only";
import { and, eq } from "@ponder/client";
import { finishFromDescription, quoteMarketPrice, type PriceQuote } from "@/lib/pricing";
import { ponderServer, schema } from "@/lib/ponder-server";
import { t, type Row } from "@/lib/ponder-bridge";
import { scryfall as sharedScryfall, type Scryfall } from "@/lib/scryfall";

/** The card's mint description (its ENS `description` record), which carries ", foil" for foils. */
async function mintDescription(cardId: bigint): Promise<string | null> {
  const db = ponderServer().db;
  const names = (await db.select().from(t(schema.ensNames)).where(eq(t(schema.ensNames.cardId), cardId)).limit(1)) as Row<typeof schema.ensNames>[];
  const node = names[0]?.node;
  if (!node) return null;
  const recs = (await db.select().from(t(schema.ensRecords))
    .where(and(eq(t(schema.ensRecords.node), node), eq(t(schema.ensRecords.key), "description"))).limit(1)) as Row<typeof schema.ensRecords>[];
  return recs[0]?.value ?? null;
}

/**
 * The market price quote for a vault card (lib/pricing's rule): its printing's Scryfall price for its finish, the
 * English printing as fallback, times the condition multiplier. Null when the card or its printing is unknown.
 */
export async function marketPriceForCard(card: { id: bigint; scryfallId: string; condition: string }, scryfall: Scryfall = sharedScryfall()): Promise<PriceQuote | null> {
  const [printing, description] = await Promise.all([scryfall.getCard(card.scryfallId), mintDescription(card.id)]);
  if (!printing) return null;
  return quoteMarketPrice({
    printing,
    finish: finishFromDescription(description),
    condition: card.condition,
    englishPrinting: (set, number) => scryfall.getPrinting(set, number, "en"),
  });
}
