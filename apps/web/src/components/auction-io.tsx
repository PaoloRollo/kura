"use client";

import type * as React from "react";
import { createContext, useCallback, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Abi, Address } from "viem";
import { abi } from "@kura/shared";
import type { IssuedTicket } from "@/components/world-id-gate";
import { useKuraUser } from "@/hooks/use-kura-user";
import { addresses, publicClient } from "@/lib/chain";
import { useSendTx, type SendInput, type Sent, type WalletKind } from "@/lib/tx";

export type ReadRequest = { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] };

/**
 * How the auction panel talks to the chain: sends, reads, the wallet switch and the World ID gate. The live values
 * come from Privy and viem; /design previews provide fixtures through `AuctionIoContext` so nothing is sent.
 */
export type AuctionIo = {
  send: (input: SendInput) => Promise<Sent>;
  walletKind: WalletKind | null;
  read: <T = unknown>(req: ReadRequest) => Promise<T>;
  /** Logs out and back in, to pick another wallet (p5hrR "Switch wallet"). */
  switchWallet: () => void;
  /** A fixed ticket (previews); undefined uses the cached one. */
  ticket?: IssuedTicket | null;
  /** The World ID button (previews swap the IDKit widget for a stub). */
  Gate?: React.ComponentType<GateProps>;
  /** Starting values for the bid form's fields (previews). */
  formDefaults?: { budget?: string; max?: string };
};

export type GateProps = { onTicket: (t: IssuedTicket) => void; onError: (code: string, details?: Record<string, unknown>) => void; autoStart?: boolean };

export const AuctionIoContext = createContext<Partial<AuctionIo> | null>(null);

export function useAuctionIo(): AuctionIo {
  const override = useContext(AuctionIoContext);
  const live = useSendTx();
  const { logout, login } = useKuraUser();
  const read = useCallback(<T,>(req: ReadRequest) => publicClient.readContract(req as never) as Promise<T>, []);
  const switchWallet = useCallback(() => {
    void Promise.resolve(logout()).then(() => login());
  }, [logout, login]);
  return {
    send: override?.send ?? live.send,
    walletKind: override?.walletKind !== undefined ? override.walletKind : live.walletKind,
    read: override?.read ?? read,
    switchWallet: override?.switchWallet ?? switchWallet,
    ticket: override?.ticket,
    Gate: override?.Gate,
    formDefaults: override?.formDefaults,
  };
}

/** Live auction state read from the chain, polled each block: what the indexer lags on or only knows after settle. */
export type AuctionChain = {
  /** `clearingPrice()`: the stored clearing price (the latest checkpoint's). */
  clearingQ96: bigint | null;
  /** The viewer's USDC balance. */
  balance: bigint | null;
  /** `isGraduated()`, read once the auction is over. */
  graduated: boolean | null;
  /** `currencyRaised()` */
  raised: bigint | null;
  /** `totalCleared()`, 18-decimal shards sold. */
  cleared: bigint | null;
  refetch: () => Promise<unknown>;
};

export function useAuctionChain(auction: Address, me: string | null, ended: boolean): AuctionChain {
  const io = useAuctionIo();
  const q = useQuery({
    queryKey: ["auction-chain", auction, me?.toLowerCase() ?? null, ended],
    queryFn: async () => {
      const call = <T,>(functionName: string, args?: readonly unknown[]) => io.read<T>({ address: auction, abi: abi.ccaAuction, functionName, args }).catch(() => null);
      const [clearingQ96, raised, cleared, graduated, balance] = await Promise.all([
        call<bigint>("clearingPrice"),
        call<bigint>("currencyRaised"),
        call<bigint>("totalCleared"),
        ended ? call<boolean>("isGraduated") : Promise.resolve(null),
        me ? io.read<bigint>({ address: addresses.usdc, abi: abi.erc20, functionName: "balanceOf", args: [me] }).catch(() => null) : Promise.resolve(null),
      ]);
      return { clearingQ96, raised, cleared, graduated, balance };
    },
    refetchInterval: 12_000,
    staleTime: 6_000,
  });
  const d = q.data;
  return { clearingQ96: d?.clearingQ96 ?? null, balance: d?.balance ?? null, graduated: d?.graduated ?? null, raised: d?.raised ?? null, cleared: d?.cleared ?? null, refetch: q.refetch };
}
