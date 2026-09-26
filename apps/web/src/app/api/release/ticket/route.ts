import { NextResponse } from "next/server";
import { withAuth } from "@/lib/http";
import { CARD_STATE, latestPending, readVaultCard, settleTicket } from "@/lib/release-tickets";
import { cardIdParam } from "../card-id";

/**
 * The caller's own waiting release ticket for the card ("Show this to the vendor"), or null. Null too once the card is
 * no longer Whole or no longer theirs: the vendor would not be offered that ticket either.
 */
export const GET = withAuth(async (req, user) => {
  const cardId = cardIdParam(req);
  const card = await readVaultCard(cardId);
  const owns = card.state === CARD_STATE.Whole && !!card.owner && card.owner.toLowerCase() === user.wallet.toLowerCase();
  const row = owns ? await latestPending(cardId, user.wallet) : null;
  return NextResponse.json({ ready: row ? { id: row.id, cardId: row.cardId.toString(), expiresAt: row.expiresAt.toString() } : null });
});

/** The holder cancels: their pending ticket for the card is dropped, so the vendor can no longer pick it up. */
export const DELETE = withAuth(async (req, user) => {
  return NextResponse.json({ cancelled: await settleTicket({ cardId: cardIdParam(req), subject: user.wallet }, "cancelled") });
});
