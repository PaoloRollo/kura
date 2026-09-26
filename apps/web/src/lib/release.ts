import type { IssuedTicket } from "@/hooks/use-world-id-ticket";
import type { Revert } from "@/lib/tx-core";

// Pure helpers behind the vendor handover (tM3Hy, ykB2t): the panel's stage, its checklist and the release call.

/** CardVault.State.Released. */
export const RELEASED_STATE = 4;

/** `confirmRelease(id, ticket, sig)` arguments from the verify route's JSON ticket. */
export function releaseArgs(cardId: bigint, issued: IssuedTicket) {
  const t = issued.ticket;
  return [cardId, { kind: t.kind, subject: t.subject, nullifier: BigInt(t.nullifier), expiresAt: BigInt(t.expiresAt) }, issued.signature] as const;
}

export type ReleaseStage =
  | { kind: "idle" }
  | { kind: "starting" }
  /** The QR is up. `scanned`: the holder opened it in World App and is confirming there. */
  | { kind: "waiting"; uri: string | null; secondsLeft: number; scanned: boolean }
  | { kind: "verifying" }
  | { kind: "refused"; message: string }
  | { kind: "expired"; what: "request" | "ticket" }
  | { kind: "verified"; issued: IssuedTicket; secondsLeft: number }
  | { kind: "released"; hash: `0x${string}` | null };

export type ReleaseInputs = {
  starting: boolean;
  /** The rp context's `expires_at` (unix seconds) once a request is open. */
  rpExpiresAt: number | null;
  uri: string | null;
  scanned: boolean;
  verifying: boolean;
  error: string | null;
  issued: IssuedTicket | null;
  released: { hash: `0x${string}` | null } | null;
  /** Unix seconds. */
  now: number;
};

/** The panel's stage, newest first: released, a ticket (valid or expired), a refusal, the backend check, the open QR. */
export function releaseStage(i: ReleaseInputs): ReleaseStage {
  if (i.released) return { kind: "released", hash: i.released.hash };
  if (i.issued) {
    const left = Number(i.issued.ticket.expiresAt) - i.now;
    return left > 0 ? { kind: "verified", issued: i.issued, secondsLeft: left } : { kind: "expired", what: "ticket" };
  }
  if (i.error) return { kind: "refused", message: i.error };
  if (i.verifying) return { kind: "verifying" };
  if (i.rpExpiresAt != null) {
    const left = i.rpExpiresAt - i.now;
    return left > 0 ? { kind: "waiting", uri: i.uri, secondsLeft: left, scanned: i.scanned } : { kind: "expired", what: "request" };
  }
  return i.starting ? { kind: "starting" } : { kind: "idle" };
}

export type CheckStatus = "pending" | "active" | "done";
export const CHECKLIST = [
  "Holder verifies with Passport",
  "Backend signs a single-use release ticket",
  "Confirm handover on-chain, ENS name revoked",
] as const;

/** The three checklist dots for a stage. */
export function checklist(stage: ReleaseStage): [CheckStatus, CheckStatus, CheckStatus] {
  switch (stage.kind) {
    case "verifying":
      return ["done", "active", "pending"];
    case "verified":
      return ["done", "done", "active"];
    case "released":
      return ["done", "done", "done"];
    default:
      return ["active", "pending", "pending"];
  }
}

/** "14:52". Negative input reads 00:00. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const REASONS: Record<string, { title: string; body: string }> = {
  OnlyVendor: { title: "Only the vendor wallet can release cards", body: "Sign in with the vendor wallet and try again." },
  WrongState: { title: "This card can't be handed over now", body: "Only a whole card in the vault can be released. It may have been sharded or released already." },
  WrongTicketKind: { title: "That ticket isn't a Passport ticket", body: "A release needs a Passport check. Run the check again." },
  TicketSubjectMismatch: { title: "The ticket names a different wallet", body: "The card changed hands since the check. Run the Passport check again with the current holder." },
  BadSignature: { title: "The vault didn't accept the ticket's signature", body: "Run the Passport check again for a fresh ticket." },
  Expired: { title: "The release ticket expired", body: "Tickets last 15 minutes. Run the Passport check again." },
  TicketUsed: { title: "This ticket was already used", body: "Each release ticket works once. Run the Passport check again." },
};

/** Why a release was refused, in the vendor's words. */
export function describeReleaseError(_e: unknown, revert: Revert): { title: string; body?: string } {
  const name = revert.inner?.name ?? revert.name;
  if (name && REASONS[name]) return { title: REASONS[name].title, body: `${REASONS[name].body} Nothing was released.` };
  if (revert.hash) return { title: "The release reverted", body: "It was mined but the vault rejected it. Nothing was released." };
  if (/reject|denied|cancel/i.test(revert.message)) return { title: "Request cancelled", body: "The release was not sent." };
  return { title: "Couldn't send the release", body: revert.message };
}

/** A refused ticket or card state repeats on a plain retry: those need a new Passport check (or nothing can be done). */
export function releaseRetryable(revert: Revert): boolean {
  const name = revert.inner?.name ?? revert.name;
  return !name || !(name in REASONS);
}
