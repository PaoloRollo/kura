import { NextResponse } from "next/server";
import { withAuth } from "@/lib/http";
import { latestPending, settleTicket } from "@/lib/release-tickets";
import { cardIdParam } from "../card-id";

/** The caller's own waiting release ticket for the card ("Show this to the vendor"), or null. */
export const GET = withAuth(async (req, user) => {
  const row = await latestPending(cardIdParam(req), user.wallet);
  return NextResponse.json({ ready: row ? { cardId: row.cardId.toString(), expiresAt: row.expiresAt.toString() } : null });
});

/** The holder cancels: their pending ticket for the card is dropped, so the vendor can no longer pick it up. */
export const DELETE = withAuth(async (req, user) => {
  return NextResponse.json({ cancelled: await settleTicket({ cardId: cardIdParam(req), subject: user.wallet }, "cancelled") });
});
