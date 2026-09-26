"use client";

import { createContext, useCallback, useContext } from "react";
import type { Abi, Address } from "viem";
import { apiFetch, useKuraUser } from "@/hooks/use-kura-user";
import type { AppraiseResult } from "@/lib/appraise";
import { publicClient } from "@/lib/chain";
import { indexerCollectors } from "@/lib/collectors";
import { resolveOwner, type ResolvedOwner } from "@/lib/owner";
import { useSendTx, type SendInput, type Sent, type WalletKind } from "@/lib/tx";

export type VaultRead = { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] };

/** A failed appraisal request: the server's error code ("NO_PRICE") and message. */
export class AppraiseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/**
 * How the redeem, payout and send panels reach the chain and the server. Live values come from Privy, viem and
 * /api/appraise; /design previews provide fixtures through `VaultIoContext`, so nothing is sent.
 */
export type VaultIo = {
  send: (input: SendInput) => Promise<Sent>;
  walletKind: WalletKind | null;
  read: <T = unknown>(req: VaultRead) => Promise<T>;
  appraise: (cardId: bigint) => Promise<AppraiseResult>;
  /** A typed Kura handle ("kenji" or "kenji.kura.eth") → the collector's address. Handles only, like the station. */
  resolveHandle: (input: string) => Promise<ResolvedOwner | null>;
};

export const VaultIoContext = createContext<Partial<VaultIo> | null>(null);

export function useVaultIo(): VaultIo {
  const override = useContext(VaultIoContext);
  const live = useSendTx();
  const { identityToken } = useKuraUser();
  const read = useCallback(<T,>(req: VaultRead) => publicClient.readContract(req as never) as Promise<T>, []);
  const appraise = useCallback(
    async (cardId: bigint) => {
      const res = await apiFetch("/api/appraise", { method: "POST", body: JSON.stringify({ cardId: cardId.toString() }), identityToken });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new AppraiseError(body?.error?.code ?? "UNAVAILABLE", body?.error?.message ?? "Couldn't get an appraisal right now");
      return body as AppraiseResult;
    },
    [identityToken],
  );
  const resolveHandle = useCallback((input: string) => resolveOwner(input, indexerCollectors), []);
  return {
    send: override?.send ?? live.send,
    walletKind: override?.walletKind !== undefined ? override.walletKind : live.walletKind,
    read: override?.read ?? read,
    appraise: override?.appraise ?? appraise,
    resolveHandle: override?.resolveHandle ?? resolveHandle,
  };
}
