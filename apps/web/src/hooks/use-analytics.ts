"use client";

import { useCallback, useMemo } from "react";
import { count, desc, inArray } from "@ponder/client";
import { usePonderQuery } from "@ponder/react";
import { useIsFetching } from "@tanstack/react-query";
import { useAttributes, useIndexerBlock, useMarketPrices } from "@/hooks/use-explore";
import { useNow } from "@/hooks/use-now";
import { useMultibaasFigures, useMultibaasRecent } from "@/hooks/use-multibaas-figures";
import { useVaultFeeBps } from "@/hooks/use-vault-fee";
import type { RecentPanel } from "@/components/multibaas-recent";
import { analyticsView, withMultibaas, type AnalyticsRange, type AnalyticsView } from "@/lib/analytics-view";
import { schema, t, type Row } from "@/lib/ponder";

type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];
type CardRow = Row<typeof schema.cards>;
type ShardingRow = Row<typeof schema.shardings>;
type ActiveRow = Row<typeof schema.activeAuctions>;
type CheckpointRow = Pick<Row<typeof schema.checkpoints>, "auction" | "blockNumber" | "clearingPriceQ96">;
type ActivityRow = Pick<Row<typeof schema.activities>, "kind" | "amount" | "actor" | "timestamp" | "meta">;
type FeeRow = Pick<Row<typeof schema.feeEvents>, "amountUsdc" | "timestamp">;

const ZERO = "0x0000000000000000000000000000000000000000" as const;

// Module level: usePonderQuery re-subscribes whenever the query function changes. Every query is one aggregate read
// over the whole vault (no per-card queries).
const cardsQuery = (db: Db) => db.select().from(t(schema.cards)) as Promise<CardRow[]>;
const shardingsQuery = (db: Db) => db.select().from(t(schema.shardings)).orderBy(desc(t(schema.shardings.createdAt))) as Promise<ShardingRow[]>;
const activeQuery = (db: Db) => db.select().from(t(schema.activeAuctions)) as Promise<ActiveRow[]>;
const activitiesQuery = (db: Db) =>
  db.select({
    kind: t(schema.activities.kind),
    amount: t(schema.activities.amount),
    actor: t(schema.activities.actor),
    timestamp: t(schema.activities.timestamp),
    meta: t(schema.activities.meta),
  }).from(t(schema.activities)).where(inArray(t(schema.activities.kind), ["settle", "redeem"])) as Promise<ActivityRow[]>;
const feesQuery = (db: Db) =>
  db.select({ amountUsdc: t(schema.feeEvents.amountUsdc), timestamp: t(schema.feeEvents.timestamp) }).from(t(schema.feeEvents)) as Promise<FeeRow[]>;
const collectorsQuery = (db: Db) => db.select({ n: count() }).from(t(schema.bidderBindings)) as Promise<{ n: number }[]>;

export type AnalyticsData = {
  view: AnalyticsView | null;
  isLoading: boolean;
  feeBps: number | null;
  recent: RecentPanel | null;
  /** The 24h range reads MultiBaas right now (the route answered its figures), whatever range is selected. */
  multibaas24h: boolean;
};

/**
 * The Analytics dashboard's live data: cards, shardings, active auctions and their latest checkpoints, settle and redeem
 * activities, fees and the World ID bindings count from the indexer; one batched attributes request (name, art) and
 * one batched market-price request for the sharded and auctioning cards; the live feeBps. For 24h, raised, fees, mints
 * and volume come from MultiBaas Event Queries when `/api/analytics/multibaas` answers (lib/analytics-view
 * `withMultibaas`), the indexer's otherwise; and MultiBaas's newest vault events for the recent panel, when it answers.
 */
export function useAnalytics(range: AnalyticsRange): AnalyticsData {
  const cards = usePonderQuery({ queryFn: cardsQuery });
  const shardings = usePonderQuery({ queryFn: shardingsQuery });
  const active = usePonderQuery({ queryFn: activeQuery });
  const activities = usePonderQuery({ queryFn: activitiesQuery });
  const fees = usePonderQuery({ queryFn: feesQuery });
  const collectors = usePonderQuery({ queryFn: collectorsQuery });
  const block = useIndexerBlock();
  const now = useNow(30_000);
  const feeBps = useVaultFeeBps();
  const mb = useMultibaasFigures(range);
  const mbRecent = useMultibaasRecent();

  const auctions = (active.data ?? []).map((a) => a.auction).sort();
  const auctionsKey = auctions.join(",");
  const checkpoints = usePonderQuery({
    queryFn: useCallback(
      (db: Db) =>
        db.select({ auction: t(schema.checkpoints.auction), blockNumber: t(schema.checkpoints.blockNumber), clearingPriceQ96: t(schema.checkpoints.clearingPriceQ96) })
          .from(t(schema.checkpoints))
          .where(inArray(t(schema.checkpoints.auction), auctions.length > 0 ? auctions : [ZERO]))
          .orderBy(desc(t(schema.checkpoints.blockNumber))) as Promise<CheckpointRow[]>,
      // eslint-disable-next-line react-hooks/exhaustive-deps -- auctionsKey is the stable identity of `auctions`
      [auctionsKey],
    ),
  });

  const cardRows = useMemo(() => cards.data ?? [], [cards.data]);
  const mapped = cardRows.filter((c) => c.state === "sharded" || c.state === "auctioning");
  const attributes = useAttributes(cardRows.filter((c) => c.state !== "released").map((c) => c.scryfallId));
  const markets = useMarketPrices(mapped.map((c) => c.id));
  // useMarketPrices leaves a card out until its batch arrives; wait for it (while it is fetching) so the premiums panel
  // does not flash its "no market price" note. A failed batch stops fetching and the panel degrades instead.
  const pricesFetching = useIsFetching({ queryKey: ["card-prices"] }) > 0;
  const pricesPending = pricesFetching && mapped.some((c) => !markets.has(c.id.toString()));

  const isLoading = cards.isLoading || shardings.isLoading || active.isLoading || checkpoints.isLoading || activities.isLoading || fees.isLoading || collectors.isLoading || pricesPending || mb.pending || block == null;
  const base = isLoading || block == null ? null : analyticsView({
    cards: cardRows,
    shardings: shardings.data ?? [],
    active: active.data ?? [],
    checkpoints: checkpoints.data ?? [],
    activities: activities.data ?? [],
    fees: fees.data ?? [],
    collectors: Number(collectors.data?.[0]?.n ?? 0),
    markets,
    attributes,
    block,
    now,
    range,
  });
  const view = base && withMultibaas(base, mb.figures, range);
  // Names for MultiBaas's events: every card ever minted (released included), by id.
  const names = useMemo(
    () => new Map(cardRows.map((c) => [c.id.toString(), attributes[c.scryfallId]?.name || c.label])),
    [cardRows, attributes],
  );
  const recent = mbRecent && { recent: mbRecent, names, now };
  return { view, isLoading, feeBps, recent, multibaas24h: mb.available24h };
}
