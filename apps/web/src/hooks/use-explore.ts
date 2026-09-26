"use client";

import { useMemo } from "react";
import { desc } from "@ponder/client";
import { usePonderQuery, usePonderStatus } from "@ponder/react";
import { useQueries } from "@tanstack/react-query";
import type { CardAttributesMap } from "@/lib/card-attributes";
import { usePools } from "@/hooks/use-pools";
import { buildAuctionItems, inTab, type AuctionItem, type ExploreTab } from "@/lib/explore";
import { quoteUsdc, type PriceQuote } from "@/lib/pricing";
import { schema, t, type Row } from "@/lib/ponder";

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

/** Most ids one /api/cards/attributes request carries (the route's cap). */
const ATTRIBUTE_BATCH = 100;

/** Card attributes (/api/cards/attributes) for many scryfall ids, one request per 100 ids. */
export function useAttributes(scryfallIds: readonly string[]): CardAttributesMap {
  const sorted = [...new Set(scryfallIds)].sort();
  const batches: string[][] = [];
  for (let i = 0; i < sorted.length; i += ATTRIBUTE_BATCH) batches.push(sorted.slice(i, i + ATTRIBUTE_BATCH));
  return useQueries({
    queries: batches.map((b) => ({
      queryKey: ["card-attributes", b.join(",")],
      queryFn: () => json<CardAttributesMap>(`/api/cards/attributes?ids=${encodeURIComponent(b.join(","))}`),
      staleTime: 5 * 60_000,
      retry: 1,
    })),
    combine: (results) => Object.assign({}, ...results.map((r) => r.data ?? {})) as CardAttributesMap,
  });
}

/** Most ids one /api/cards/prices request carries (the route's cap). */
const PRICE_BATCH = 100;

/**
 * Whole-card market prices (USDC) by card id, through the batched /api/cards/prices (lib/pricing's rule): one request
 * per 100 ids. Missing while loading; null for a card without a price.
 */
export function useMarketPrices(ids: readonly bigint[]): Map<string, bigint | null> {
  const sorted = [...new Set(ids.map(String))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const batches: string[][] = [];
  for (let i = 0; i < sorted.length; i += PRICE_BATCH) batches.push(sorted.slice(i, i + PRICE_BATCH));
  const results = useQueries({
    queries: batches.map((b) => ({
      queryKey: ["card-prices", b.join(",")],
      queryFn: () => json<Record<string, PriceQuote | null>>(`/api/cards/prices?ids=${b.join(",")}`),
      staleTime: 5 * 60_000,
      retry: 1,
    })),
  });
  const out = new Map<string, bigint | null>();
  for (const r of results) for (const [id, q] of Object.entries(r.data ?? {})) out.set(id, quoteUsdc(q));
  return out;
}

/** Name and art per card id, from the card attributes (one request), else the card's label. */
export function identities(cards: readonly Pick<CardRow, "id" | "label" | "scryfallId">[], attributes: CardAttributesMap): Map<string, { name: string; image: string }> {
  return new Map(cards.map((c) => {
    const a = attributes[c.scryfallId];
    return [c.id.toString(), { name: a?.name || c.label, image: a?.image ?? "" }];
  }));
}

export type ExploreData = { items: AuctionItem[]; newCards: NewCard[]; block: bigint | null; isLoading: boolean };

/**
 * Live Explore data: every auction (active and settled) joined with its card, the card attributes (name, art, set, one
 * request for all) and market prices. Prices are fetched only for the items on `tab`.
 */
export function useExploreData(tab: ExploreTab): ExploreData {
  const cards = usePonderQuery({ queryFn: cardsQuery });
  const shardings = usePonderQuery({ queryFn: shardingsQuery });
  const active = usePonderQuery({ queryFn: activeQuery });
  const block = useIndexerBlock();
  const pools = usePools();

  const cardRows = useMemo(() => cards.data ?? [], [cards.data]);
  const newRows = useMemo(() => cardRows.slice(0, NEW_IN_VAULT), [cardRows]);
  const listed = useMemo(() => {
    const ids = new Set((shardings.data ?? []).map((s) => s.cardId.toString()));
    for (const c of newRows) ids.add(c.id.toString());
    return cardRows.filter((c) => ids.has(c.id.toString()));
  }, [shardings.data, cardRows, newRows]);
  const attributes = useAttributes(listed.map((c) => c.scryfallId));
  const idents = identities(listed, attributes);

  const build = (markets: ReadonlyMap<string, bigint | null>) => block == null ? [] : buildAuctionItems({
    active: active.data ?? [],
    shardings: shardings.data ?? [],
    cards: cardRows,
    metas: idents,
    attributes,
    markets,
    block,
    pools,
  });
  const shown = block == null ? [] : build(new Map()).filter((it) => inTab(it, tab, block)).map((it) => it.cardId);
  const markets = useMarketPrices(shown);
  const items = build(markets);
  const newCards: NewCard[] = newRows.map((c) => {
    const m = idents.get(c.id.toString());
    return { id: c.id, name: m?.name ?? c.label, image: m?.image || null, owner: c.beneficialOwner, mintedAt: c.mintedAt };
  });
  return { items, newCards, block, isLoading: cards.isLoading || shardings.isLoading || active.isLoading || block == null };
}
