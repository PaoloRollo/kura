"use client";

import Link from "next/link";
import { SearchIcon } from "lucide-react";
import { Segmented } from "@/components/kura";
import { ChartFrame } from "@/components/charts/chart-frame";
import { DailyBars } from "@/components/charts/daily-bars";
import { KpiStrip, type Kpi } from "@/components/charts/kpi-strip";
import { Leaderboard } from "@/components/charts/leaderboard";
import { MarketTreemap } from "@/components/charts/market-treemap";
import { ShareBars } from "@/components/charts/share-bars";
import { MobilePageTitle } from "@/components/page-title";
import { IndexerLoading } from "@/components/sync-state";
import { Skeleton } from "@/components/ui/skeleton";
import { RANGES, mintedSub, type AnalyticsRange, type AnalyticsView } from "@/lib/analytics-view";
import { fullDayCoveredAt } from "@/lib/multibaas/recent";
import { RecentVaultEvents, utcTime, type RecentPanel } from "@/components/multibaas-recent";
import { money } from "@/lib/format";
import { Countdown } from "@/components/countdown";

const EMPTY = "Nothing in the vault yet.";

/** A chart panel with a note in place of the plot (the empty vault, no ranked cards yet). */
function NotePanel({ title, subtitle, note, className }: { title: string; subtitle?: string; note: string; className?: string }) {
  return (
    <ChartFrame title={title} subtitle={subtitle} table={{ columns: [title], rows: [[note]] }} className={className}>
      <p className="py-8 text-center text-[12px] text-muted-foreground">{note}</p>
    </ChartFrame>
  );
}

/**
 * Which source the aggregates came from, under the KPI strip. 24h reads MultiBaas once it has indexed a full day; 7d
 * and All always read the indexer (MultiBaas keeps 72 h of events). The title says what each one covers.
 */
function SourceNote({ view, range, recent, multibaas24h }: { view: AnalyticsView; range: AnalyticsRange; recent: RecentPanel | null; multibaas24h: boolean }) {
  const multibaas = view.source === "multibaas";
  const takeover = recent ? fullDayCoveredAt(recent.recent.coverage) : null;
  // MultiBaas answers (the recent panel has data) but has not indexed a full day yet: the 24h figures come later.
  const before = !multibaas24h && takeover != null && takeover > recent!.now;
  // Past that time, reachable, yet the 24h figures still refused: the next snapshot (≤ 20 min) should have them.
  const catchingUp = !multibaas24h && recent != null && !before;
  const title = multibaas
    ? "24h raised, fees, mints and volume from MultiBaas Event Queries; live state from the Ponder indexer"
    : range !== "24h"
      ? "MultiBaas keeps 72 h of events, so 7d and All come from the Ponder indexer; 24h reads MultiBaas once it has indexed a full day"
      : before
        ? `MultiBaas answers the 24h figures once it has indexed a full day (from ${utcTime(takeover!)}); until then every figure comes from the Ponder indexer`
        : catchingUp
          ? "MultiBaas is catching up on the full 24 h window; until it answers, every figure comes from the Ponder indexer"
          : "MultiBaas is unavailable or not configured; every figure comes from the Ponder indexer";
  // Only claim MultiBaas for 24h when the 24h figures really come from it.
  const extra = multibaas
    ? null
    : range === "24h"
      ? (before ? `MultiBaas from ${utcTime(takeover!)}` : null)
      : multibaas24h
        ? "24h via MultiBaas"
        : before
          ? `24h via MultiBaas from ${utcTime(takeover!)}`
          : null;
  return (
    <p className="-mt-3 text-right text-[11px] text-muted-foreground lg:-mt-5">
      <span title={title}>{multibaas ? "Data: MultiBaas" : "Data: indexer"}</span>
      {extra && <> · <span>{extra}</span></>}
    </p>
  );
}

function tiles(v: AnalyticsView, range: AnalyticsRange, feeBps: number | null): Kpi[] {
  const t = v.tiles;
  return [
    { label: "Cards in vault", value: t.cardsInVault, sub: mintedSub(range, t.mintedInRange), hideOnMobile: true },
    { label: "Value locked", value: money(t.valueLocked, 0), sub: "implied at clearing" },
    { label: "Raised", value: money(t.raised, 0), sub: `across ${t.raisedAuctions} auction${t.raisedAuctions === 1 ? "" : "s"}` },
    { label: "Fees to vault", value: money(t.fees, 0), sub: `${feeBps != null ? `${feeBps / 100}% ` : ""}of sales + buyouts` },
    { label: "Live auctions", value: t.liveAuctions, sub: t.nextEndBlock != null ? <>next ends in <Countdown endBlock={t.nextEndBlock} /></> : "none running", hideOnMobile: true },
    { label: "Verified collectors", shortLabel: "Collectors", value: t.collectors, sub: "World ID, one per human" },
  ];
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <IndexerLoading title="Loading the vault's analytics" className="max-w-md" />
      <Skeleton className="h-[108px] rounded-2xl bg-surface" />
      <Skeleton className="h-[400px] rounded-2xl bg-surface max-md:hidden" />
      <div className="grid gap-4 lg:grid-cols-[1.45fr_1fr_0.7fr]">
        <Skeleton className="h-[290px] rounded-2xl bg-surface" />
        <Skeleton className="h-[270px] rounded-2xl bg-surface" />
        <Skeleton className="h-[250px] rounded-2xl bg-surface max-md:hidden" />
      </div>
    </div>
  );
}

/**
 * Collector · Analytics (Y1eNn 1440, WABQw 390): the heading and range control, the KPI strip, the market map, then
 * daily volume, richest premiums and cards by language, then MultiBaas's recent vault events when it answers. Phones
 * get four tiles, no market map and no language panel.
 */
export function AnalyticsDashboard({ view, isLoading, feeBps, range, onRange, recent = null, multibaas24h = false }: {
  view: AnalyticsView | null;
  isLoading: boolean;
  feeBps: number | null;
  range: AnalyticsRange;
  onRange: (r: AnalyticsRange) => void;
  /** MultiBaas's newest vault events; null while unavailable (the panel is left out). */
  recent?: RecentPanel | null;
  /** The 24h range reads MultiBaas right now (whatever range is selected): the label may then say so on 7d and All. */
  multibaas24h?: boolean;
}) {
  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <MobilePageTitle
        title="Analytics"
        className="-mt-2"
        right={
          <Link href="/app" aria-label="Search cards" className="flex size-9 items-center justify-center rounded-md text-text-2 hover:text-text [&_svg]:size-5">
            <SearchIcon aria-hidden />
          </Link>
        }
      />
      <header className="flex flex-wrap items-end justify-between gap-4 max-md:hidden">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-[40px] leading-tight font-semibold text-text">The vault, live</h1>
          <p className="text-[14px] text-text-2">Every card, shard and auction indexed from Sepolia. Updates each block.</p>
        </div>
        <Segmented label="Time range" options={RANGES} value={range} onChange={onRange} className="w-[148px]" />
      </header>

      {isLoading || !view ? (
        <DashboardSkeleton />
      ) : (
        <>
          <KpiStrip items={tiles(view, range, feeBps)} />
          <SourceNote view={view} range={range} recent={recent} multibaas24h={multibaas24h} />
          <div className="max-md:hidden">
            {view.empty ? (
              <NotePanel title="Market map" subtitle="Size is implied value. Color is premium or discount to the Scryfall price." note={EMPTY} />
            ) : (
              <MarketTreemap items={view.treemap} />
            )}
          </div>
          <div className="grid gap-8 md:grid-cols-2 md:gap-4 lg:grid-cols-[1.45fr_1fr_0.7fr] lg:items-start">
            {view.empty ? (
              <NotePanel title="Daily volume" subtitle="USDC through auctions and buyouts" note={EMPTY} />
            ) : (
              <DailyBars points={view.volume} label="Volume, USDC" unit={view.window.unit} title={view.window.unit === "hour" ? "Hourly volume" : "Daily volume"} />
            )}
            {view.empty || view.premiums.length === 0 ? (
              <NotePanel title="Richest premiums" subtitle="Clearing price vs market" note={view.empty ? EMPTY : "No settled card has a market price yet."} />
            ) : (
              <Leaderboard title="Richest premiums" subtitle="Clearing price vs market" valueLabel="Premium" rows={view.premiums} />
            )}
            <div className="max-md:hidden">
              {view.empty ? <NotePanel title="By language" subtitle="Cards in vault" note={EMPTY} /> : <ShareBars rows={view.languages} />}
            </div>
          </div>
          {recent && <RecentVaultEvents {...recent} />}
        </>
      )}
    </div>
  );
}
