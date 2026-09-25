"use client";

import { desc, gt } from "@ponder/client";
import { usePonderQuery } from "@ponder/react";
import { useQueries } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { abi } from "@kura/shared";
import { addresses } from "@/lib/chain";
import type { CardMetadata } from "@/lib/meta";
import { schema, t, type Row } from "@/lib/ponder";

// Query functions live at module level: usePonderQuery re-subscribes its live query whenever the function changes.
type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];
export type CardRow = Row<typeof schema.cards>;
export type FeeRow = Row<typeof schema.feeEvents>;
export type ShardingRow = Row<typeof schema.shardings>;
export type BalanceRow = Row<typeof schema.shardBalances>;
const cardsQuery = (db: Db) => db.select().from(t(schema.cards)).orderBy(desc(t(schema.cards.id))) as Promise<CardRow[]>;
const feesQuery = (db: Db) => db.select().from(t(schema.feeEvents)).orderBy(desc(t(schema.feeEvents.timestamp))) as Promise<FeeRow[]>;
const shardingsQuery = (db: Db) => db.select().from(t(schema.shardings)) as Promise<ShardingRow[]>;
const balancesQuery = (db: Db) => db.select().from(t(schema.shardBalances)).where(gt(t(schema.shardBalances.balance), 0n)) as Promise<BalanceRow[]>;

/** Every vault card, newest first; live. */
export const useVaultCards = () => usePonderQuery({ queryFn: cardsQuery });
/** Every fee event, newest first; live. */
export const useFeeEvents = () => usePonderQuery({ queryFn: feesQuery });
export const useShardings = () => usePonderQuery({ queryFn: shardingsQuery });
/** Shard balances above zero, for holder counts. */
export const useShardBalances = () => usePonderQuery({ queryFn: balancesQuery });

/** ERC-721 metadata (/api/meta/[id]) for each card id, keyed by id. Missing while loading or on failure. */
export function useCardMetas(ids: readonly bigint[]): Map<bigint, CardMetadata> {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["card-meta", id.toString()],
      queryFn: async (): Promise<CardMetadata> => {
        const res = await fetch(`/api/meta/${id}`);
        if (!res.ok) throw new Error(`meta ${id}: ${res.status}`);
        return res.json();
      },
      staleTime: 5 * 60_000,
      retry: 1,
    })),
  });
  return new Map(ids.flatMap((id, i) => (results[i]?.data ? [[id, results[i].data] as const] : [])));
}

const vault = { address: addresses.cardVault, abi: abi.cardVault } as const;

/** The vault's fee settings: payout address, fee, owner and the fee cap. */
export function useVaultConfig() {
  const q = useReadContracts({
    allowFailure: false,
    contracts: [
      { ...vault, functionName: "payout" },
      { ...vault, functionName: "feeBps" },
      { ...vault, functionName: "owner" },
      { ...vault, functionName: "MAX_FEE_BPS" },
    ],
  });
  const [payout, feeBps, owner, maxFeeBps] = q.data ?? [];
  return { payout: payout as Address | undefined, feeBps: feeBps as number | undefined, owner: owner as Address | undefined, maxFeeBps: maxFeeBps as number | undefined, refetch: q.refetch, isLoading: q.isLoading };
}

/** USDC held by the vault's payout address: the header's "Fees 412.30 USDC" chip. */
export function usePayoutBalance() {
  const { payout } = useVaultConfig();
  const q = useReadContract({
    address: addresses.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: payout ? [payout] : undefined,
    query: { enabled: !!payout, refetchInterval: 30_000 },
  });
  return q.data;
}
