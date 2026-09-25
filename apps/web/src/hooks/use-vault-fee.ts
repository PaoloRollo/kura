"use client";

import { useQuery } from "@tanstack/react-query";
import { abi } from "@kura/shared";
import { addresses, publicClient } from "@/lib/chain";

/** The vault's fee in basis points, read live from `CardVault.feeBps()` (250 on Sepolia); null while it loads. */
export function useVaultFeeBps(): number | null {
  const q = useQuery({
    queryKey: ["vault-fee-bps"],
    queryFn: async () => Number(await publicClient.readContract({ address: addresses.cardVault, abi: abi.cardVault, functionName: "feeBps" })),
    staleTime: 60_000,
  });
  return q.data ?? null;
}
