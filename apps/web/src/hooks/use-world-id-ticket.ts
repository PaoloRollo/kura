"use client";

import { useCallback } from "react";
import type { RpContext } from "@worldcoin/idkit";
import { apiFetch, useKuraUser } from "@/hooks/use-kura-user";

export type WorldAction = "bid" | "release";
export type IssuedTicket = { ticket: { kind: number; subject: `0x${string}`; nullifier: string; expiresAt: string }; signature: `0x${string}`; credential: string };
/** A release proof went through: the ticket is stored for the vendor station until `expiresAt` (unix seconds). */
export type ReleaseReady = { ok: true; cardId: string; expiresAt: string; credential: string };

/** A refused verification: the server's code (ALREADY_BOUND, SIGNAL_MISMATCH...) and its `details`, or START_FAILED. */
export class WorldIdError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Fetcher = typeof apiFetch;

/** A fresh, single-use rp context for `action` (the nonce World signs over). Throws WorldIdError("START_FAILED"). */
export async function fetchRpContext(action: WorldAction, identityToken: string | null, fetcher: Fetcher = apiFetch): Promise<RpContext> {
  const r = await fetcher("/api/worldid/rp-context", { method: "POST", body: JSON.stringify({ action }), identityToken }).catch(() => null);
  if (!r?.ok) throw new WorldIdError("START_FAILED", `rp-context ${r?.status ?? "unreachable"}`);
  const j = await r.json();
  return { rp_id: j.rp_id, nonce: j.nonce, created_at: j.created_at, expires_at: j.expires_at, signature: j.signature };
}

/**
 * Has the backend verify an IDKit result. Bid: the signed ticket comes back. Release (`cardId`, the signed-in owner's
 * card): the ticket is stored for the vendor station and only its expiry comes back. The subject is always the caller.
 * A refusal throws WorldIdError with the server's code and details.
 */
export async function verifyProof(
  p: { action: WorldAction; cardId?: bigint; idkitResponse: unknown; identityToken: string | null },
  fetcher: Fetcher = apiFetch,
): Promise<IssuedTicket | ReleaseReady> {
  const res = await fetcher("/api/worldid/verify", {
    method: "POST",
    body: JSON.stringify({ action: p.action, cardId: p.cardId?.toString(), idkitResponse: p.idkitResponse }),
    identityToken: p.identityToken,
  });
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
    throw new WorldIdError(error?.code ?? "VERIFY_FAILED", error?.message ?? "Verification failed", error?.details);
  }
  return (await res.json()) as IssuedTicket | ReleaseReady;
}

/**
 * The one verified path to a World ID ticket, for bids and for the owner's release check: fetch an rp context, then
 * post the IDKit result to /api/worldid/verify.
 */
export function useWorldIdTicket({ action, cardId }: { action: WorldAction; cardId?: bigint }) {
  const { identityToken } = useKuraUser();
  const rpContext = useCallback(() => fetchRpContext(action, identityToken ?? null), [action, identityToken]);
  const verify = useCallback(
    (idkitResponse: unknown) => verifyProof({ action, cardId, idkitResponse, identityToken: identityToken ?? null }),
    [action, cardId, identityToken],
  );
  return { ready: !!identityToken, identityToken: identityToken ?? null, rpContext, verify };
}
