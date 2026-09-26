"use client";

import { useMemo } from "react";
import { desc } from "@ponder/client";
import { usePonderQuery, usePonderStatus } from "@ponder/react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { CardAttributesMap } from "@/lib/card-attributes";
import { buildAuctionItems, nameOf, type AuctionItem } from "@/lib/explore";
import type { CardMetadata } from "@/lib/meta";
import { quoteUsdc, type PriceQuote } from "@/lib/pricing";
import { schema, t, type Row } from "@/lib/ponder";
import { useCardMetas } from "@/hooks/use-vendor-data";

type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];
type CardRow = Row<typeof schema.cards>;
type ShardingRow = Row<typeof schema.shardings>;
type ActiveRow = Row<typeof schema.activeAuctions>;

// Module level: usePonderQuery re-subscribes whenever the query function changes.
const cardsQuery = (db: Db) => db.select().from(t(schema.cards)).orderBy(desc(t(schema.cards.mintedAt))) as Promise<CardRow[]>;
const shardingsQuery = (db: Db) => db.select().from(t(schema.shardings)).orderBy(desc(t(schema.shardings.updatedAt))) as Promise<ShardingRow[]>;
const activeQuery = (db: Db) => db.select().from(t(schema.activeAuctions)) as Promise<ActiveRow[]>;

/** "New in the vault": the latest minted cards. */
export type NewCard = { id: bigint; name: string; image: string | null; owner: `0x${string}`; mintedAt: number };

export const NEW_IN_VAULT = 5;

/** The indexer's latest block, as a bigint (null while the status loads). */
export function useIndexerBlock(): bigint | null {
  const n = usePonderStatus().data?.sepolia?.block?.number;
  return n != null ? BigInt(n) : null;
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Card attributes (/api/cards/attributes) for many scryfall ids in one call. */
export function useAttributes(scryfallIds: readonly string[]): CardAttributesMap {
  const key = [...new Set(scryfallIds)].sort().join(",");
  const q = useQuery<CardAttributesMap>({
    queryKey: ["card-attributes", key],
    queryFn: () => json(`/api/cards/attributes?ids=${encodeURIComponent(key)}`),
    enabled: key.length > 0,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return q.data ?? {};
}

/** Whole-card market prices (USDC) by card id, through /api/cards/[id]/price (lib/pricing's rule). Missing while loading. */
export function useMarketPrices(ids: readonly bigint[]): Map<string, bigint | null> {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["card-price", id.toString()],
      queryFn: () => json<PriceQuote>(`/api/cards/${id}/price`),
      staleTime: 5 * 60_000,
      retry: 1,
    })),
  });
  return new Map(ids.flatMap((id, i) => (results[i]?.isSuccess ? [[id.toString(), quoteUsdc(results[i].data)] as const] : [])));
}

export type ExploreData = { items: AuctionItem[]; newCards: NewCard[]; block: bigint | null; isLoading: boolean };

/** Live Explore data: every auction (active and settled), joined with cards, metadata, attributes and market prices. */
export function useExploreData(): ExploreData {
  const cards = usePonderQuery({ queryFn: cardsQuery });
  const shardings = usePonderQuery({ queryFn: shardingsQuery });
  const active = usePonderQuery({ queryFn: activeQuery });
  const block = useIndexerBlock();

  const cardRows = useMemo(() => cards.data ?? [], [cards.data]);
  const auctionIds = useMemo(() => [...new Set((shardings.data ?? []).map((s) => s.cardId))], [shardings.data]);
  const newRows = cardRows.slice(0, NEW_IN_VAULT);
  const metaIds = useMemo(() => [...new Set([...auctionIds, ...newRows.map((c) => c.id)])], [auctionIds, newRows]);
  const metas = useCardMetas(metaIds);
  const scryfallIds = useMemo(() => {
    const ids = new Set(auctionIds.map((id) => id.toString()));
    return cardRows.filter((c) => ids.has(c.id.toString())).map((c) => c.scryfallId);
  }, [auctionIds, cardRows]);
  const attributes = useAttributes(scryfallIds);
  const markets = useMarketPrices(auctionIds);

  const metaMap = new Map<string, CardMetadata>([...metas.entries()].map(([id, m]) => [id.toString(), m]));
  const items = block == null ? [] : buildAuctionItems({
    active: active.data ?? [],
    shardings: shardings.data ?? [],
    cards: cardRows,
    metas: metaMap,
    attributes,
    markets,
    block,
  });
  const newCards: NewCard[] = newRows.map((c) => {
    const m = metaMap.get(c.id.toString());
    return { id: c.id, name: nameOf(m, c), image: m?.image || null, owner: c.beneficialOwner, mintedAt: c.mintedAt };
  });
  return { items, newCards, block, isLoading: cards.isLoading || shardings.isLoading || active.isLoading || block == null };
}
