import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { TTL, TicketKind, type Ticket } from "@kura/shared";
import { getDb } from "@/lib/db/client";
import { tickets, worldidVerifications } from "@/lib/db/schema";
import { HttpError, parseBody, withAuth } from "@/lib/http";
import { requireOwnerOfWholeCard, storeReleaseTicket } from "@/lib/release-tickets";
import { nowSec, serializeTicket, signTicket } from "@/lib/signer";
import { requireEnv, verifyWorld, type IdkitResponseLike } from "@/lib/world";

const Body = z.object({
  action: z.enum(["bid", "release"]),
  /** Release only: the card the caller wants to collect. The subject is always the caller. */
  cardId: z.string().regex(/^\d+$/).optional(),
  idkitResponse: z.object({ responses: z.array(z.record(z.unknown())) }).passthrough(),
});

export const POST = withAuth(async (req, user) => {
  const body = await parseBody(Body, req);
  const db = getDb();

  // The proof is bound to the caller's own wallet for both actions: for release that is the card's owner, collecting in
  // their own session. A vendor-chosen subject would let any Passport holder scan a ticket into someone else's name.
  const subject: `0x${string}` = user.wallet;
  let cardId: bigint | null = null;
  if (body.action === "release") {
    if (!body.cardId) throw new HttpError("BAD_REQUEST", "cardId is required for release", 400);
    cardId = BigInt(body.cardId);
    // Checked before World is asked, so a refused request never binds a nullifier.
    await requireOwnerOfWholeCard(cardId, subject);
  }

  const result = await verifyWorld({
    rpId: requireEnv("WORLD_RP_ID"),
    action: body.action,
    subject,
    idkitResponse: body.idkitResponse as unknown as IdkitResponseLike,
    expectedEnv: process.env.WORLD_ENV ?? "staging",
  });

  const nullifier = result.nullifier.toString();
  // One nullifier per action is bound to one wallet (bid: the bidder; release: the card holder). Insert-first with
  // ON CONFLICT DO NOTHING, then read back the winning row, so two concurrent requests cannot both bind.
  await db
    .insert(worldidVerifications)
    .values({ id: crypto.randomUUID(), nullifier, action: body.action, subject, environment: result.environment, credential: result.credential })
    .onConflictDoNothing({ target: [worldidVerifications.nullifier, worldidVerifications.action] });
  const [bound] = await db.select().from(worldidVerifications).where(and(eq(worldidVerifications.nullifier, nullifier), eq(worldidVerifications.action, body.action))).limit(1);
  if (!bound || bound.subject.toLowerCase() !== subject.toLowerCase()) {
    throw new HttpError("ALREADY_BOUND", "this World ID is already linked to another wallet", 409, bound ? { boundTo: bound.subject } : undefined);
  }

  const kind = body.action === "bid" ? TicketKind.HUMAN : TicketKind.PASSPORT;
  const ttl = body.action === "bid" ? TTL.bidTicketSec : TTL.releaseTicketSec;
  const ticket: Ticket = { kind, subject, nullifier: result.nullifier, expiresAt: nowSec() + BigInt(ttl) };
  const domain = body.action === "bid" ? "bidgate" : "vault";
  const signature = await signTicket(ticket, domain);
  await db.insert(tickets).values({ id: crypto.randomUUID(), kind, subject, nullifier, expiresAt: ticket.expiresAt, signature, domain });

  if (cardId != null) {
    // The holder only learns it is ready; the vendor station collects the ticket by card id.
    await storeReleaseTicket({ cardId, subject, nullifier: result.nullifier, expiresAt: ticket.expiresAt, signature });
    return NextResponse.json({ ok: true, cardId: cardId.toString(), expiresAt: ticket.expiresAt.toString(), credential: result.credential });
  }
  return NextResponse.json({ ticket: serializeTicket(ticket), signature, credential: result.credential });
});
