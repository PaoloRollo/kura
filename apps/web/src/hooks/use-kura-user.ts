"use client";

import { useIdentityToken, usePrivy, useWallets } from "@privy-io/react-auth";
import type { Address } from "viem";
import deployments from "@/generated/deployments.json";
import { identityAddress } from "@/lib/tx-core";

export function useKuraUser() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { identityToken } = useIdentityToken();
  // The server's rule (lib/auth.ts): the embedded wallet first, otherwise the first linked Ethereum wallet.
  const embedded = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
  const address = (user ? identityAddress(user.linkedAccounts as never) : null) ?? (embedded?.address as Address | undefined) ?? null;
  const isVendor = !!address && address.toLowerCase() === deployments.vendor.toLowerCase();
  return { ready: ready && walletsReady, authenticated, login, logout, address, isVendor, identityToken };
}

/** fetch() with the Privy identity token attached; the server derives the wallet from it. */
export async function apiFetch(path: string, init: RequestInit & { identityToken?: string | null } = {}) {
  const headers = new Headers(init.headers);
  if (init.identityToken) headers.set("privy-id-token", init.identityToken);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(path, { ...init, headers });
}
