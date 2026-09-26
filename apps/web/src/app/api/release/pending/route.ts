import { NextResponse } from "next/server";
import { withAuth } from "@/lib/http";
import { CARD_STATE, latestPending, pendingJson, readVaultCard } from "@/lib/release-tickets";
import { requireVendor } from "@/lib/scan";
import { cardIdParam } from "../card-id";

/**
 * Vendor only: the release ticket the card's owner signed for in their own session, if one is waiting. Only an
 * unexpired pending ticket naming the card's current on-chain owner, while the card is Whole.
 */
export const GET = withAuth(async (req, user) => {
  requireVendor(user);
  const cardId = cardIdParam(req);
  const card = await readVaultCard(cardId);
  if (card.state !== CARD_STATE.Whole || !card.owner) return NextResponse.json({ pending: null });
  const row = await latestPending(cardId, card.owner);
  return NextResponse.json({ pending: row ? pendingJson(row) : null });
});
