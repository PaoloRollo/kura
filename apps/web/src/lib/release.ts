import { keccak256, stringToHex } from "viem";
import type { IssuedTicket } from "@/hooks/use-world-id-ticket";
import type { Revert } from "@/lib/tx-core";

// Pure helpers behind the handover: the vendor panel (tM3Hy, ykB2t), the owner's "Collect at the counter" and the release call.

/** CardVault.State.Released. */
export const RELEASED_STATE = 4;

/** `confirmRelease(id, ticket, sig)` arguments from the verify route's JSON ticket. */
export function releaseArgs(cardId: bigint, issued: IssuedTicket) {
  const t = issued.ticket;
  return [cardId, { kind: t.kind, subject: t.subject, nullifier: BigInt(t.nullifier), expiresAt: BigInt(t.expiresAt) }, issued.signature] as const;
}

/** A ticket the owner signed for in their own session, as the vendor station receives it. */
export type PendingRelease = IssuedTicket & { id: string };

export type ReleaseStage =
  /** No ticket yet: the owner has to tap "Collect at the counter" in their own Kura app. */
  | { kind: "waiting" }
  | { kind: "expired" }
  | { kind: "verified"; pending: PendingRelease; secondsLeft: number }
  | { kind: "released"; hash: `0x${string}` | null };

/** The vendor panel's stage: released, then the owner's ticket (valid or expired), else waiting for the owner. */
export function releaseStage(i: { pending: PendingRelease | null; released: { hash: `0x${string}` | null } | null; now: number }): ReleaseStage {
  if (i.released) return { kind: "released", hash: i.released.hash };
  if (!i.pending) return { kind: "waiting" };
  const left = Number(i.pending.ticket.expiresAt) - i.now;
  return left > 0 ? { kind: "verified", pending: i.pending, secondsLeft: left } : { kind: "expired" };
}

export type CheckStatus = "pending" | "active" | "done";
export const CHECKLIST = [
  "Holder verified Passport in their app",
  "Vendor confirms the handover",
  "Released on-chain, ENS name revoked",
] as const;

/** The three checklist dots for a stage. */
export function checklist(stage: ReleaseStage): [CheckStatus, CheckStatus, CheckStatus] {
  switch (stage.kind) {
    case "verified":
      return ["done", "active", "pending"];
    case "released":
      return ["done", "done", "done"];
    default:
      return ["active", "pending", "pending"];
  }
}

// No 0/O, 1/I/L: the code is read aloud or compared by eye at the counter.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/**
 * The 4-character counter match code for a stored release ticket, from a hash of its id. The holder's screen and the
 * vendor's station derive it from the same id, so the vendor can check they are looking at the same ticket.
 */
export function matchCode(ticketId: string): string {
  const h = keccak256(stringToHex(ticketId));
  let out = "";
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[parseInt(h.slice(2 + i * 2, 4 + i * 2), 16) % CODE_ALPHABET.length];
  return out;
}

/**
 * The owner's side ("Collect at the counter"): nothing waiting, a ticket ready to show, one that ran out, or one that
 * stopped waiting on its own (used by the vendor, refused, or dropped because the card changed).
 */
export type CollectStage = { kind: "idle" } | { kind: "ready"; secondsLeft: number; code: string } | { kind: "expired" } | { kind: "ended" };
export function collectStage(ready: { id: string; expiresAt: string } | null, now: number, ended = false): CollectStage {
  if (!ready) return ended ? { kind: "ended" } : { kind: "idle" };
  const left = Number(ready.expiresAt) - now;
  return left > 0 ? { kind: "ready", secondsLeft: left, code: matchCode(ready.id) } : { kind: "expired" };
}

/** "14:52". Negative input reads 00:00. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const REASONS: Record<string, { title: string; body: string }> = {
  OnlyVendor: { title: "Only the vendor wallet can release cards", body: "Sign in with the vendor wallet and try again." },
  WrongState: { title: "This card can't be handed over now", body: "Only a whole card in the vault can be released. It may have been sharded or released already." },
  WrongTicketKind: { title: "That ticket isn't a Passport ticket", body: "A release needs a Passport check. Ask the holder to verify again in their app." },
  TicketSubjectMismatch: { title: "The ticket names a different wallet", body: "The card changed hands since the check. The current owner has to verify in their own app." },
  BadSignature: { title: "The vault didn't accept the ticket's signature", body: "Ask the holder to verify again in their app for a fresh ticket." },
  Expired: { title: "The release ticket expired", body: "Tickets last 15 minutes. Ask the holder to verify again in their app." },
  TicketUsed: { title: "This ticket was already used", body: "Each release ticket works once. Ask the holder to verify again in their app." },
  UnknownCard: { title: "The card's ENS name couldn't be revoked", body: "The name registry has no name for this card. Check the card id with the vault owner." },
  ERC721NonexistentToken: { title: "This card doesn't exist in the vault", body: "Check the card id." },
};

/** Why a release was refused, in the vendor's words. */
export function describeReleaseError(_e: unknown, revert: Revert): { title: string; body?: string } {
  const name = revert.inner?.name ?? revert.name;
  if (name && REASONS[name]) return { title: REASONS[name].title, body: `${REASONS[name].body} Nothing was released.` };
  if (name?.startsWith("ERC721")) return { title: "The card token refused the release", body: `The vault's card token reverted with ${name}. Nothing was released.` };
  if (revert.hash) return { title: "The release reverted", body: "It was mined but the vault rejected it. Nothing was released." };
  if (/reject|denied|cancel/i.test(revert.message)) return { title: "Request cancelled", body: "The release was not sent." };
  return { title: "Couldn't send the release", body: revert.message };
}

/** A refused ticket or card state repeats on a plain retry: those need a new Passport check (or nothing can be done). */
export function releaseRetryable(revert: Revert): boolean {
  const name = revert.inner?.name ?? revert.name;
  return !name || !(name in REASONS || name.startsWith("ERC721"));
}

/** After these the stored ticket can never go through; it is marked consumed so the station stops offering it. */
export function ticketSpent(revert: Revert): boolean {
  const name = revert.inner?.name ?? revert.name;
  return !!name && name !== "OnlyVendor" && !releaseRetryable(revert);
}
