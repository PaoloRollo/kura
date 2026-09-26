"use client";

import { useCallback, useMemo } from "react";
import { desc, eq } from "@ponder/client";
import { usePonderQuery } from "@ponder/react";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { useIndexerBlock, useMarketPrices } from "@/hooks/use-explore";
import { useHandlesState } from "@/hooks/use-handles";
import { useTicket } from "@/hooks/use-ticket";
import { useCardMetas, useShardings, useVaultCards } from "@/hooks/use-vendor-data";
import { addresses, publicClient } from "@/lib/chain";
import { nameOf } from "@/lib/explore";
import { allocation, bidItems, holdings, payouts, totals, wholeCards, type BidItem, type Holding, type Totals, type WholeCard } from "@/lib/portfolio";
import { schema, t, type Row } from "@/lib/ponder";

type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];
type Hex = `0x${string}`;
export type ShardingRow = Row<typeof schema.shardings>;
type BalanceRow = Row<typeof schema.shardBalances>;
type BidRow = Row<typeof schema.bids>;
type ActiveRow = Row<typeof schema.activeAuctions>;
type ActivityRow = Row<typeof schema.activities>;
type BindingRow = Row<typeof schema.bidderBindings>;

const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const activeQuery = (db: Db) => db.select().from(t(schema.activeAuctions)) as Promise<ActiveRow[]>;

/** A bought-out sharding I still hold shards of, for the payout banner. */
export type PayoutItem = { sharding: ShardingRow; name: string };
export type ReleasedItem = WholeCard & { ensName: string; releasedAt: number | null };

export type PortfolioData = {
  me: Hex;
  holdings: Holding[];
  payouts: PayoutItem[];
  whole: WholeCard[];
  released: ReleasedItem[];
  bids: { live: BidItem[]; ended: BidItem[] };
  totals: Totals;
  allocation: ReturnType<typeof allocation>;
  /** USDC balance (6 decimals); null while it loads. */
  usdc: bigint | null;
  /** World ID: a bidder binding for my wallet (it outlives the 24 h ticket), else a valid cached ticket. */
  verified: boolean;
  /** My Kura handle ("paolo"), or null. */
  handle: string | null;
  block: bigint | null;
  isLoading: boolean;
};

/** USDC balance, keyed ["usdc", address] like the header chip, so a confirmed transaction refreshes both. */
export function useUsdcBalance(address: string | null): bigint | null {
  const q = useQuery({
    queryKey: ["usdc", address?.toLowerCase() ?? null],
    queryFn: () => publicClient.readContract({ abi: erc20Abi, address: addresses.usdc, functionName: "balanceOf", args: [address as Address] }),
    enabled: !!address,
    refetchInterval: 30_000,
  });
  return q.data ?? null;
}

/** World ID status for `me`: a bidder binding row, else a valid cached bid ticket. */
export function useWorldIdVerified(me: string | null): { verified: boolean; binding: BindingRow | null } {
  const wallet = (me?.toLowerCase() ?? ZERO) as Hex;
  const q = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.bidderBindings)).where(eq(t(schema.bidderBindings.wallet), wallet)).limit(1) as Promise<BindingRow[]>, [wallet]),
  });
  const ticket = useTicket("bid", me);
  const binding = q.data?.[0] ?? null;
  return { verified: !!binding || ticket.valid, binding };
}

/** Everything the portfolio shows for `me`, live. */
export function usePortfolio(me: Hex): PortfolioData {
  const wallet = me.toLowerCase() as Hex;
  const cards = useVaultCards();
  const shardings = useShardings();
  const active = usePonderQuery({ queryFn: activeQuery });
  const balances = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.shardBalances)).where(eq(t(schema.shardBalances.holder), wallet)) as Promise<BalanceRow[]>, [wallet]),
  });
  const bids = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.bids)).where(eq(t(schema.bids.owner), wallet)).orderBy(desc(t(schema.bids.submittedAt))) as Promise<BidRow[]>, [wallet]),
  });
  const activities = usePonderQuery({
    queryFn: useCallback(
      (db: Db) => db.select().from(t(schema.activities)).where(eq(t(schema.activities.actor), wallet)).orderBy(desc(t(schema.activities.blockNumber))).limit(500) as Promise<ActivityRow[]>,
      [wallet],
    ),
  });
  const block = useIndexerBlock();
  const { handles } = useHandlesState();
  const { verified } = useWorldIdVerified(me);
  const usdc = useUsdcBalance(me);

  const cardRows = useMemo(() => cards.data ?? [], [cards.data]);
  const shardingRows = useMemo(() => shardings.data ?? [], [shardings.data]);
  const balanceRows = balances.data ?? [];
  const bidRows = bids.data ?? [];
  const activeRows = active.data ?? [];
  const activityRows = activities.data ?? [];

  // Cards I touch: held shards, bids, whole or released cards of mine.
  const tokenCard = new Map(shardingRows.map((s) => [s.shardToken.toLowerCase(), s.cardId]));
  const ids = [...new Set([
    ...balanceRows.filter((b) => b.balance > 0n).flatMap((b) => tokenCard.get(b.shardToken.toLowerCase()) ?? []),
    ...bidRows.map((b) => b.cardId),
    ...cardRows.filter((c) => c.ownerOf.toLowerCase() === wallet).map((c) => c.id),
  ].map(String))].map(BigInt);
  const metas = useCardMetas(ids);
  const wholeIds = cardRows.filter((c) => c.ownerOf.toLowerCase() === wallet && c.state === "whole").map((c) => c.id);
  const markets = useMarketPrices(wholeIds);

  const byId = new Map(cardRows.map((c) => [c.id.toString(), c]));
  const ident = (id: bigint) => {
    const m = metas.get(id);
    const c = byId.get(id.toString());
    return { name: c ? nameOf(m, c) : m ? nameOf(m, { label: `#${id}` }) : `Card #${id}`, image: m?.image || null };
  };
  const head = block ?? 0n;
  const h = holdings({ me, balances: balanceRows, shardings: shardingRows, cards: cardRows, bids: bidRows, activities: activityRows, active: activeRows, block: head, ident });
  const w = wholeCards(me, cardRows, ident, (id) => markets.get(id.toString()) ?? null);
  const releasedAt = new Map(activityRows.filter((a) => a.kind === "release").map((a) => [String(a.cardId), a.timestamp]));
  return {
    me,
    holdings: h,
    payouts: payouts(me, balanceRows, shardingRows).map((s) => ({ sharding: s, name: ident(s.cardId).name })),
    whole: w.whole,
    released: w.released.map((r) => ({ ...r, ensName: byId.get(r.cardId.toString())?.ensName ?? "", releasedAt: releasedAt.get(r.cardId.toString()) ?? null })),
    bids: bidItems({ me, bids: bidRows, shardings: shardingRows, active: activeRows, block: head, ident }),
    totals: totals(h, w.whole),
    allocation: allocation(h, w.whole),
    usdc,
    verified,
    handle: handles[wallet] ?? null,
    block,
    isLoading: cards.isLoading || shardings.isLoading || balances.isLoading || bids.isLoading || block == null,
  };
}
