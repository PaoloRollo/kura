"use client";

import type * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { parseUnits } from "viem";
import { q96ToUsdcPerShard } from "@kura/shared";
import { AddressName } from "@/components/address-name";
import { ChartFrame, SwatchNote } from "@/components/charts/chart-frame";
import { DemandBars } from "@/components/charts/demand-bars";
import { HolderBars, type HolderPoint } from "@/components/charts/holder-bars";
import { KpiStrip, type Kpi } from "@/components/charts/kpi-strip";
import { OwnershipBar, type OwnershipSlice } from "@/components/charts/ownership-bar";
import { PriceBars, type PriceMark, type PricePoint } from "@/components/charts/price-bars";
import { IndexerLoading } from "@/components/sync-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { CardData, ShardingRow } from "@/hooks/use-card";
import { useVaultFeeBps } from "@/hooks/use-vault-fee";
import type { MarketPoint } from "@/app/api/cards/[id]/market/route";
import { addresses } from "@/lib/chain";
import { SERIES, premiumLabel } from "@/lib/chart-colors";
import { clearingPerShard, custodians, holdersView, pct, shareOf } from "@/lib/card-view";
import { money, shardsFixed, shortAddress } from "@/lib/format";
import { distanceToRedemption, feesByKind, fillRate, hhi, impliedValueUsdc, participation, premium, shares, tokensSold } from "@/lib/metrics";
import { marketPerShard, priceSourceLabel, quoteUsdc } from "@/lib/pricing";
import { clearingLevel, demandCurve, holderSeries } from "@/lib/series";
import { cn } from "@/lib/utils";

const lc = (a: string) => a.toLowerCase();
const SECONDS_PER_BLOCK = 12;
/** Price bars: at most this many for the auction itself, plus the settle bar and the flat tail after it. */
const AUCTION_BARS = 13;
const LIVE_BARS = 20;
const FLAT_BARS = 6;
const HOLDER_BARS = 12;
const UNCLAIMED_COLOR = "color-mix(in srgb, var(--kura-muted) 45%, transparent)";

/** USDC (6 decimals) as a plain number of dollars, for the charts. */
const dollars = (x: bigint) => Number(x) / 1e6;
/** "100%", "66.7%", "0%". */
const pctTrim = (f: number) => `${Number((f * 100).toFixed(1))}%`;
/** Shards to one decimal, "3" rather than "3.0". */
const shardsTrim = (x: bigint) => shardsFixed(x, 1).replace(/\.0$/, "");

/** The last value of each of `k` equal index buckets: keeps the shape of a long series in `k` bars. */
export function lastPerBucket<T>(xs: readonly T[], k: number): T[] {
  if (xs.length <= k) return [...xs];
  return Array.from({ length: k }, (_, i) => xs[Math.floor(((i + 1) * xs.length) / k) - 1]!);
}

type Activity = CardData["activities"][number];
const metaToken = (a: Activity) => (a.meta as { shardToken?: string } | null)?.shardToken;
const ofToken = (activities: readonly Activity[], kind: string, token: string) =>
  activities.find((a) => a.kind === kind && lc(String(metaToken(a) ?? "")) === lc(token)) ?? null;

export type AnalyticsInput = {
  data: CardData;
  /** Unix seconds. */
  now: number;
  /** The daily market series from /api/cards/[id]/market ([] until the snapshot cron has run). */
  market: readonly MarketPoint[];
  feeBps: number | null;
};

/** Everything the tab shows, derived from `CardData` (pure, so the tests and previews share it). */
export function cardAnalyticsView({ data, now, market, feeBps }: AnalyticsInput) {
  const card = data.card!;
  // The current sharding, or the latest one once the card is whole again (its history).
  const s: ShardingRow | null = data.sharding ?? data.allShardings[0] ?? null;
  if (!s) return null;
  const vault = addresses.cardVault;
  const excluded = custodians(data.allShardings, vault);
  const live = s.graduated === null;
  const failed = s.graduated === false;
  const settle = ofToken(data.activities, "settle", s.shardToken);
  const redeem = ofToken(data.activities, "redeem", s.shardToken);
  const shard = ofToken(data.activities, "shard", s.shardToken);
  const boughtOut = s.redeemer != null || card.state === "whole" || card.state === "released";

  // --- Price per shard: one bar per checkpoint (by block), bucketed; flat at the final clearing after the settle.
  const cps = data.checkpoints.filter((c) => lc(c.auction) === lc(s.auction)).sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
  const anchor = cps[0];
  const timeOf = (block: bigint) => (anchor ? anchor.timestamp + Number(block - anchor.blockNumber) * SECONDS_PER_BLOCK : 0);
  const raw: PricePoint[] = cps.map((c) => ({ t: timeOf(c.blockNumber), clearing: dollars(q96ToUsdcPerShard(c.clearingPriceQ96)) }));
  const points = lastPerBucket(raw, live ? LIVE_BARS : AUCTION_BARS);
  const marks: PriceMark[] = [];
  let settledAt: number | undefined;
  const final = clearingPerShard(s);
  if (!failed && settle && final != null && points.length > 0) {
    settledAt = settle.timestamp;
    if (points.at(-1)!.t < settle.timestamp) points.push({ t: settle.timestamp, clearing: dollars(final) });
    const end = redeem ? redeem.timestamp : now;
    const step = (end - settle.timestamp) / FLAT_BARS;
    if (step > 0) for (let k = 1; k <= FLAT_BARS; k++) points.push({ t: Math.round(settle.timestamp + k * step), clearing: dollars(final) });
    marks.push({ t: settle.timestamp, label: "S" });
    if (redeem) marks.push({ t: redeem.timestamp, label: "B" });
  }
  const appraisal = data.ensNode ? data.ensRecords.find((r) => r.key === "appraisal.usd" && lc(r.node) === lc(data.ensNode!)) : undefined;
  const appraisalT = appraisal && anchor ? timeOf(appraisal.updatedBlock) : null;
  if (appraisalT != null && points.length > 0 && appraisalT >= points[0]!.t && appraisalT <= points.at(-1)!.t) marks.push({ t: appraisalT, label: "A" });

  // --- Market: the daily snapshots over the window when the cron has run, else the live quote.
  const quote = quoteUsdc(data.price);
  const quotePerShard = marketPerShard(quote, s.totalShards);
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const perShard = market
    .filter((m) => m.adjustedUsd)
    .map((m) => ({ date: m.date, v: marketPerShard(parseUnits(m.adjustedUsd!, 6), s.totalShards) }))
    .filter((m): m is { date: string; v: bigint } => m.v != null);
  let windowMarket: bigint[] = [];
  if (perShard.length > 0 && points.length > 0) {
    const from = day(points[0]!.t), to = day(points.at(-1)!.t);
    const before = perShard.filter((m) => m.date < from).at(-1);
    windowMarket = [...(before ? [before] : []), ...perShard.filter((m) => m.date >= from && m.date <= to)].map((m) => m.v);
  }
  const marketLine = windowMarket.at(-1) ?? quotePerShard;
  const flat = windowMarket.length <= 1 || windowMarket.every((v) => v === windowMarket[0]);
  const marketFooter: React.ReactNode =
    marketLine == null ? <span className="text-muted-foreground">No market price: Scryfall has no USD price for this printing.</span>
    : flat ? <SwatchNote color={SERIES.s2}>Market {money(marketLine)} / shard, flat over the window</SwatchNote>
    : <SwatchNote color={SERIES.s2}>Market {money(windowMarket.reduce((a, b) => (b < a ? b : a)))} to {money(windowMarket.reduce((a, b) => (b > a ? b : a)))} / shard over the window, latest {money(marketLine)} marked</SwatchNote>;
  const priceFooter: React.ReactNode = failed
    ? <span className="flex flex-col gap-1"><span>Reserve not met. The auction didn&apos;t graduate. Nothing was sold.</span>{marketFooter}</span>
    : marketFooter;

  // --- Demand: the current auction's bids by max price, the clearing level marked.
  const bids = data.bids.filter((b) => lc(b.auction) === lc(s.auction));
  const curve = demandCurve(bids);
  const liveQ96 = cps.at(-1)?.clearingPriceQ96 ?? null;
  const clearingUsdc = live ? (liveQ96 != null ? q96ToUsdcPerShard(liveQ96) : null) : final;
  const level = clearingLevel(curve, clearingUsdc);
  const demand = {
    points: curve.map((l) => ({ price: dollars(l.maxUsdcPerShard), cumulative: dollars(l.cumulativeUsdc) })),
    clearing: level >= 0 ? dollars(curve[level]!.maxUsdcPerShard) : null,
    forSale: s.forSale,
    footer: failed ? `Reserve not met: demand didn't reach the ${money(s.reserveUsdc, 0)} reserve. Every bid was refunded.`
      // No bid sits exactly at the clearing level: still say where it cleared.
      : level < 0 && clearingUsdc != null && curve.length > 0 ? `${live ? "Clearing now at" : "Cleared at"} ${money(clearingUsdc, 0)} for the ${s.forSale} shard${s.forSale === 1 ? "" : "s"} for sale.`
      : undefined,
  };

  // --- Holders over time and ownership.
  const holderPoints: HolderPoint[] = lastPerBucket(
    holderSeries(data.transfers.filter((tr) => lc(tr.shardToken) === lc(s.shardToken)), excluded).map((p) => ({ t: p.timestamp, holders: p.holders })),
    HOLDER_BARS,
  );
  const view = holdersView({ balances: data.holders, sharding: s, shardings: data.allShardings, transfers: data.transfers, vault });
  const slices: OwnershipSlice[] = view.rows.map((r) => ({ id: r.holder, name: shortAddress(r.holder), label: <AddressName address={r.holder} copyable={false} avatar={false} />, value: r.share }));
  if (view.unclaimed > 0n) slices.push({ id: "unclaimed", name: "Unclaimed in auction", label: <span className="text-muted-foreground">Unclaimed in auction</span>, value: shareOf(view.unclaimed, view.supply), color: UNCLAIMED_COLOR });

  // --- KPIs.
  const implied = boughtOut ? null : impliedValueUsdc(s, liveQ96);
  const prem = premium(implied, quote);
  const why = s.redeemer != null && s.buyoutPerShard != null ? `bought out at ${money(s.buyoutPerShard, 0)}/shard` : card.state === "released" ? "released" : card.state === "whole" ? "bought out" : failed ? "reserve not met" : null;
  const ownerShares = shares(data.holders, excluded);
  const top = view.top?.balance ?? 0n;
  const distance = distanceToRedemption(top, data.supply);
  const ticks = data.ticks.filter((tk) => lc(tk.auction) === lc(s.auction));
  const sold = tokensSold(s, data.transfers.filter((tr) => lc(tr.shardToken) === lc(s.shardToken)), vault, ticks.at(-1));
  const fill = fillRate(sold, s.forSale);
  const source = data.price ? priceSourceLabel(data.price, card.condition) : undefined;

  const kpis: Kpi[] = [
    {
      label: "Implied value",
      value: implied != null ? money(implied, 0) : "n/a",
      sub: why ?? (implied == null ? "no clearing yet" : live ? `live clearing × ${s.totalShards}` : `clearing × ${s.totalShards}`),
    },
    {
      label: "Premium",
      value: premiumLabel(prem),
      tone: prem == null ? "default" : prem > 0 ? "pos" : prem < 0 ? "neg" : "default",
      sub: why ?? (implied == null ? "no clearing yet" : quote == null ? "no market price" : <span title={source}>{live ? "live, " : ""}vs Scryfall {money(quote, 0)}</span>),
    },
    {
      label: "Concentration",
      value: ownerShares.length > 0 ? hhi(ownerShares).toFixed(2) : "n/a",
      sub: "HHI, 1.0 = one owner",
    },
    boughtOut
      ? { label: "To redemption", value: "n/a", sub: card.state === "released" ? "released" : "bought out" }
      : {
        label: "To redemption",
        // The unit is set small so "389.6 shards short" fits the tile.
        value: distance.eligible ? "eligible" : <>{shardsFixed(distance.shardsShort, 1)} <span className="text-[13px] text-text-2">shards short</span></>,
        tone: distance.eligible ? "kin" : "default",
        sub: `top holder ${pct(shareOf(top, data.supply))}`,
      },
    {
      label: "Fill rate",
      value: fill != null ? pctTrim(fill) : "n/a",
      sub: failed ? "reserve not met · all refunded" : sold != null ? `${shardsTrim(sold)} of ${s.forSale} shards ${live ? "cleared, live" : "sold"}` : "no clearing yet",
    },
    { label: "Bidders", value: String(participation(bids)), sub: "unique humans" },
  ];

  return {
    kpis,
    price: { points, marks, settledAt, market: marketLine != null ? dollars(marketLine) : null, footer: priceFooter },
    demand,
    holders: { points: holderPoints, shardedAt: shard?.timestamp, settledAt: settle?.timestamp },
    ownership: { slices, empty: boughtOut ? "No holders: the shards were bought out and burned." : "No holders yet: every shard is still in the auction." },
    fees: { ...feesByKind(data.fees), feeBps },
  };
}

function Panel({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return <section aria-label={label} className={cn("flex min-w-0 flex-col gap-4 sm:rounded-2xl sm:border sm:border-border sm:bg-surface sm:p-[22px]", className)}>{children}</section>;
}

/** A chart frame with nothing to plot yet: the muted note inside the frame. */
function EmptyChart({ title, subtitle, note }: { title: string; subtitle: string; note: string }) {
  return (
    <ChartFrame title={title} subtitle={subtitle} table={{ columns: [title], rows: [] }}>
      <p className="py-10 text-center text-[12px] text-muted-foreground">{note}</p>
    </ChartFrame>
  );
}

function FeesPanel({ sale, buyout, total, feeBps }: { sale: bigint; buyout: bigint; total: bigint; feeBps: number | null }) {
  const row = "flex items-center justify-between border-b border-border pb-3 text-[13px]";
  return (
    <Panel label="Fees to the vault">
      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold text-text">Fees to the vault</h3>
        <p className="text-[12px] text-text-2 max-sm:hidden">From this card</p>
      </div>
      <dl className="flex flex-col gap-4 pt-2">
        <div className={row}><dt className="text-text-2">Auction sale</dt><dd className="font-mono text-text">{money(sale)}</dd></div>
        <div className={row}><dt className="text-text-2">Buyout</dt><dd className="font-mono text-text">{money(buyout)}</dd></div>
        <div className="flex items-center justify-between text-[13px]"><dt className="font-semibold text-text">Total</dt><dd className="font-mono text-kin">{money(total)}</dd></div>
      </dl>
      <p className="text-[11px] text-text-2">{feeBps != null ? `${Number((feeBps / 100).toFixed(2))}% of proceeds, paid at settle and on buyout.` : "Paid at settle and on buyout."}</p>
    </Panel>
  );
}

export function CardAnalyticsLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <IndexerLoading title="Loading this card's analytics" className="max-w-md" />
      <Skeleton className="h-[108px] rounded-2xl bg-surface" />
      <div className="grid gap-4 md:grid-cols-[1.74fr_1fr]">
        <Skeleton className="h-[320px] rounded-2xl bg-surface" />
        <Skeleton className="h-[240px] rounded-2xl bg-surface" />
      </div>
      <div className="grid gap-4 md:grid-cols-[1.1fr_1fr_0.64fr]">
        <Skeleton className="h-[270px] rounded-2xl bg-surface" />
        <Skeleton className="h-[230px] rounded-2xl bg-surface" />
        <Skeleton className="h-[250px] rounded-2xl bg-surface" />
      </div>
    </div>
  );
}

/**
 * The card page's Analytics tab (LqnA2): KPI strip, price per shard against market, demand curve, holders over time,
 * ownership split and fees. `market` overrides the /api/cards/[id]/market fetch (the /design previews pass fixtures).
 */
export function CardAnalytics({ data, now, market: marketFixture }: { data: CardData; now: number; market?: MarketPoint[] }) {
  const id = data.card?.id.toString() ?? "";
  const q = useQuery<MarketPoint[]>({
    queryKey: ["card-market", id],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${id}/market`);
      if (!res.ok) throw new Error(`market ${res.status}`);
      return res.json() as Promise<MarketPoint[]>;
    },
    enabled: !!id && marketFixture === undefined,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const feeBps = useVaultFeeBps();

  if (!data.card) return null;
  if (data.shardingsLoading || data.holdersLoading) return <CardAnalyticsLoading />;
  const v = cardAnalyticsView({ data, now, market: marketFixture ?? q.data ?? [], feeBps });
  if (!v) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-6">
        <p className="text-[14px] text-text-2">No analytics yet. This card hasn&apos;t been sharded.</p>
      </div>
    );
  }
  const priceTitle = { title: "Price per shard", subtitle: "Auction clearing against market, appraisal and buyout marked" };
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <KpiStrip items={v.kpis} />
      <div className="grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-[1.74fr_1fr] md:items-start">
        {v.price.points.length > 0
          ? <PriceBars points={v.price.points} marks={v.price.marks} settledAt={v.price.settledAt} market={v.price.market} footer={v.price.footer} />
          : <EmptyChart {...priceTitle} note="No bids yet" />}
        <DemandBars points={v.demand.points} clearing={v.demand.clearing} forSale={v.demand.forSale} footer={v.demand.footer} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-2 md:items-start lg:grid-cols-[1.1fr_1fr_0.64fr]">
        {v.holders.points.length > 0
          ? <HolderBars points={v.holders.points} shardedAt={v.holders.shardedAt} settledAt={v.holders.settledAt} />
          : <EmptyChart title="Holders over time" subtitle="Distinct wallets holding a shard, auction and vault excluded" note="No transfers yet" />}
        {v.ownership.slices.length > 0
          ? <OwnershipBar slices={v.ownership.slices} />
          : <EmptyChart title="Ownership split" subtitle="Share of live supply" note={v.ownership.empty} />}
        <FeesPanel {...v.fees} />
      </div>
    </div>
  );
}
