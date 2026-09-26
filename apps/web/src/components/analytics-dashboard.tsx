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
import { countdown, money } from "@/lib/format";

const EMPTY = "Nothing in the vault yet.";

/** A chart panel with a note in place of the plot (the empty vault, no ranked cards yet). */
function NotePanel({ title, subtitle, note, className }: { title: string; subtitle?: string; note: string; className?: string }) {
  return (
    <ChartFrame title={title} subtitle={subtitle} table={{ columns: [title], rows: [[note]] }} className={className}>
      <p className="py-8 text-center text-[12px] text-muted-foreground">{note}</p>
    </ChartFrame>
  );
}

function tiles(v: AnalyticsView, range: AnalyticsRange, feeBps: number | null): Kpi[] {
  const t = v.tiles;
  return [
    { label: "Cards in vault", value: t.cardsInVault, sub: mintedSub(range, t.mintedInRange), hideOnMobile: true },
    { label: "Value locked", value: money(t.valueLocked, 0), sub: "implied at clearing" },
    { label: "Raised", value: money(t.raised, 0), sub: `across ${t.raisedAuctions} auction${t.raisedAuctions === 1 ? "" : "s"}` },
    { label: "Fees to vault", value: money(t.fees, 0), sub: `${feeBps != null ? `${feeBps / 100}% ` : ""}of sales + buyouts` },
    { label: "Live auctions", value: t.liveAuctions, sub: t.nextEndsIn != null ? `next ends in ${countdown(t.nextEndsIn)}` : "none running", hideOnMobile: true },
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
 * daily volume, richest premiums and cards by language. Phones get four tiles, no market map and no language panel.
 */
export function AnalyticsDashboard({ view, isLoading, feeBps, range, onRange }: {
  view: AnalyticsView | null;
  isLoading: boolean;
  feeBps: number | null;
  range: AnalyticsRange;
  onRange: (r: AnalyticsRange) => void;
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
        </>
      )}
    </div>
  );
}
