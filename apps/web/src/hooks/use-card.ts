"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { asc, desc, eq, inArray } from "@ponder/client";
import { usePonderQuery } from "@ponder/react";
import type { CardAttributes, CardAttributesMap } from "@/lib/card-attributes";
import type { CardMetadata } from "@/lib/meta";
import type { PriceQuote } from "@/lib/pricing";
import { currentSharding } from "@/lib/card-view";
import { schema, t, type Row } from "@/lib/ponder";
import { useKuraUser } from "@/hooks/use-kura-user";

export type CardMeta = CardMetadata;
export type CardRow = Row<typeof schema.cards>;
export type ShardingRow = Row<typeof schema.shardings>;
export type BalanceRow = Row<typeof schema.shardBalances>;
export type TransferRow = Row<typeof schema.shardTransfers>;
export type ActivityRow = Row<typeof schema.activities>;
export type BidRow = Row<typeof schema.bids>;
export type TickRow = Row<typeof schema.auctionTicks>;
export type CheckpointRow = Row<typeof schema.checkpoints>;
export type EnsNameRow = Row<typeof schema.ensNames>;
export type EnsRecordRow = Row<typeof schema.ensRecords>;

type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_NODE = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** Activities fetched per card; the feed paginates client-side. */
export const ACTIVITY_LIMIT = 500;

/** Everything the card page shows about one card. `useCard` builds it live; /design previews pass fixtures. */
export type CardData = {
  card: CardRow | null;
  /** The card's current sharding, or null for a whole card (never sharded, or whole again after a buyout). */
  sharding: ShardingRow | null;
  /** Every sharding of this card, newest first (payouts of earlier ones stay claimable). */
  allShardings: ShardingRow[];
  meta: CardMeta | null;
  attributes: CardAttributes | null;
  /** The market price quote (lib/pricing's rule) from /api/cards/[id]/price. */
  price: PriceQuote | null;
  /** Balances above zero of the current shard token, auction and vault included. */
  holders: BalanceRow[];
  /** Sum of every balance of the current shard token (auction and vault included): ShardToken.totalSupply(). */
  supply: bigint;
  myBalance: bigint;
  /** Newest first: blockNumber desc, then logIndex desc. */
  activities: ActivityRow[];
  /** Shard transfers of every sharding's token. */
  transfers: TransferRow[];
  bids: BidRow[];
  ticks: TickRow[];
  /** The current auction's checkpoints, oldest first. */
  checkpoints: CheckpointRow[];
  ensNode: `0x${string}` | null;
  ensName: EnsNameRow | null;
  ensRecords: EnsRecordRow[];
  isLoading: boolean;
  /** The card's shardings haven't loaded yet: `sharding` null means "not known", not "not sharded". */
  shardingsLoading?: boolean;
  /** The current shard token's balances haven't loaded yet: `myBalance` 0 means "not known", not "holds none". */
  holdersLoading?: boolean;
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Live card data from the indexer, plus its metadata (/api/meta/[id]), attributes (/api/cards/attributes) and price quote. */
export function useCard(id: bigint): CardData {
  const { address } = useKuraUser();

  const card = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.cards)).where(eq(t(schema.cards.id), id)).limit(1) as Promise<CardRow[]>, [id]),
  });
  const row = card.data?.[0] ?? null;

  const shardingRows = usePonderQuery({
    queryFn: useCallback(
      (db: Db) => db.select().from(t(schema.shardings)).where(eq(t(schema.shardings.cardId), id)).orderBy(desc(t(schema.shardings.createdAt))) as Promise<ShardingRow[]>,
      [id],
    ),
  });
  const allShardings = shardingRows.data ?? [];
  // Null once the card is whole again: a bought-out sharding's holders and auction are history (see lastBuyout).
  const current = currentSharding(row, allShardings);
  const token = (current?.shardToken ?? ZERO_ADDRESS) as `0x${string}`;
  const auction = (current?.auction ?? ZERO_ADDRESS) as `0x${string}`;
  const tokens = allShardings.length > 0 ? allShardings.map((s) => s.shardToken) : [ZERO_ADDRESS as `0x${string}`];
  const tokensKey = tokens.join(",");

  const holders = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.shardBalances)).where(eq(t(schema.shardBalances.shardToken), token)) as Promise<BalanceRow[]>, [token]),
  });
  const transfers = usePonderQuery({
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tokensKey is the stable identity of `tokens`
    queryFn: useCallback((db: Db) => db.select().from(t(schema.shardTransfers)).where(inArray(t(schema.shardTransfers.shardToken), tokens)) as Promise<TransferRow[]>, [tokensKey]),
  });
  const activities = usePonderQuery({
    queryFn: useCallback(
      (db: Db) =>
        db.select().from(t(schema.activities)).where(eq(t(schema.activities.cardId), id))
          .orderBy(desc(t(schema.activities.blockNumber)), desc(t(schema.activities.logIndex))).limit(ACTIVITY_LIMIT) as Promise<ActivityRow[]>,
      [id],
    ),
  });
  const bids = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.bids)).where(eq(t(schema.bids.cardId), id)).orderBy(desc(t(schema.bids.submittedAt))) as Promise<BidRow[]>, [id]),
  });
  const ticks = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.auctionTicks)).where(eq(t(schema.auctionTicks.cardId), id)).orderBy(asc(t(schema.auctionTicks.blockNumber))) as Promise<TickRow[]>, [id]),
  });
  const checkpoints = usePonderQuery({
    queryFn: useCallback(
      (db: Db) => db.select().from(t(schema.checkpoints)).where(eq(t(schema.checkpoints.auction), auction)).orderBy(asc(t(schema.checkpoints.blockNumber))) as Promise<CheckpointRow[]>,
      [auction],
    ),
  });
  const names = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.ensNames)).where(eq(t(schema.ensNames.cardId), id)).limit(1) as Promise<EnsNameRow[]>, [id]),
  });
  const ensNode = (names.data?.[0]?.node ?? null) as `0x${string}` | null;
  const node = (ensNode ?? ZERO_NODE) as `0x${string}`;
  const ensRecords = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.ensRecords)).where(eq(t(schema.ensRecords.node), node)) as Promise<EnsRecordRow[]>, [node]),
  });

  const meta = useQuery<CardMeta>({ queryKey: ["card-meta", id.toString()], queryFn: () => fetchJson(`/api/meta/${id}`), enabled: !!row, staleTime: 5 * 60_000, retry: 1 });
  const scryfallId = row?.scryfallId ?? "";
  const attributes = useQuery<CardAttributesMap>({
    queryKey: ["card-attributes", scryfallId],
    queryFn: () => fetchJson(`/api/cards/attributes?ids=${encodeURIComponent(scryfallId)}`),
    enabled: !!scryfallId,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const price = useQuery<PriceQuote>({ queryKey: ["card-price", id.toString()], queryFn: () => fetchJson(`/api/cards/${id}/price`), enabled: !!row, staleTime: 5 * 60_000, retry: 1 });

  const live = (holders.data ?? []).filter((h) => h.balance > 0n);
  const myBalance = address ? live.find((h) => h.holder.toLowerCase() === address.toLowerCase())?.balance ?? 0n : 0n;
  const supply = live.reduce((a, h) => a + h.balance, 0n);

  return {
    card: row,
    sharding: current,
    allShardings,
    meta: meta.data ?? null,
    attributes: attributes.data?.[scryfallId] ?? null,
    price: price.data ?? null,
    holders: live,
    supply,
    myBalance,
    activities: activities.data ?? [],
    transfers: transfers.data ?? [],
    bids: bids.data ?? [],
    ticks: ticks.data ?? [],
    checkpoints: checkpoints.data ?? [],
    ensNode,
    ensName: names.data?.[0] ?? null,
    ensRecords: ensRecords.data ?? [],
    isLoading: card.isLoading,
    shardingsLoading: shardingRows.isLoading,
    holdersLoading: shardingRows.isLoading || (!!current && holders.isLoading),
  };
}
