// The Analytics dashboard (Y1eNn, WABQw), pure: tile values, market-map tiles, leaderboard and language rows, and the
// volume series from indexer rows, market quotes and card attributes. No React, so node tests cover it.
import { formatUnits } from "viem";
import type { DailyPoint } from "@/components/charts/daily-bars";
import type { LeaderboardRow } from "@/components/charts/leaderboard";
import type { TreemapItem } from "@/components/charts/market-treemap";
import type { ShareRow } from "@/components/charts/share-bars";
import { PREMIUM_NEUTRAL, premiumLabel } from "@/lib/chart-colors";
import { currentSharding } from "@/lib/card-view";
import { languageName } from "@/lib/explore";
import { impliedValueUsdc, premium } from "@/lib/metrics";
import { bucketSeries, type SeriesUnit } from "@/lib/series";

const lc = (a: string) => a.toLowerCase();
const HOUR = 3_600;
const DAY = 86_400;

// ---------------------------------------------------------------------------------------------------------------------
// Range

export type AnalyticsRange = "24h" | "7d" | "all";
export const RANGES: readonly { value: AnalyticsRange; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "all", label: "All" },
];
export const DEFAULT_RANGE: AnalyticsRange = "7d";
export const parseRange = (v: string | null | undefined): AnalyticsRange => (v === "24h" || v === "all" || v === "7d" ? v : DEFAULT_RANGE);

export type RangeWindow = { from: number; to: number; unit: SeriesUnit };

/**
 * The window the volume series and the activity tiles cover, in unix seconds, aligned to whole UTC buckets so it holds
 * exactly 24 hourly (24h) or 7 daily (7d) buckets, the current one included. All: whole days from the first activity's
 * day or the first mint's, whichever is earlier (today alone when there is neither).
 */
export function rangeWindow(range: AnalyticsRange, now: number, firstActivity: number | null): RangeWindow {
  if (range === "24h") return { from: Math.floor(now / HOUR) * HOUR - 23 * HOUR, to: now, unit: "hour" };
  const today = Math.floor(now / DAY) * DAY;
  if (range === "7d") return { from: today - 6 * DAY, to: now, unit: "day" };
  const first = firstActivity != null ? Math.floor(Math.min(firstActivity, now) / DAY) * DAY : today;
  return { from: first, to: now, unit: "day" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs (indexer-shaped, ponder.schema.ts)

type Hex = `0x${string}`;
export type AnalyticsCard = { id: bigint; state: "whole" | "auctioning" | "sharded" | "released"; shardToken: Hex | null; scryfallId: string; language: string; label: string; ensName: string; mintedAt: number };
export type AnalyticsSharding = { shardToken: Hex; cardId: bigint; auction: Hex; totalShards: number; graduated: boolean | null; clearingPriceQ96: bigint | null; createdAt: number };
export type AnalyticsActive = { auction: Hex; endBlock: bigint };
export type AnalyticsCheckpoint = { auction: Hex; blockNumber: bigint; clearingPriceQ96: bigint };
export type AnalyticsActivity = { kind: string; amount: bigint | null; actor: string; timestamp: number; meta: unknown };
export type AnalyticsFee = { amountUsdc: bigint; timestamp: number };

export type AnalyticsInput = {
  cards: readonly AnalyticsCard[];
  shardings: readonly AnalyticsSharding[];
  active: readonly AnalyticsActive[];
  /** Checkpoints of the active auctions, any order: the latest per auction is the live clearing. */
  checkpoints: readonly AnalyticsCheckpoint[];
  /** Settle and redeem activities (other kinds are ignored). */
  activities: readonly AnalyticsActivity[];
  fees: readonly AnalyticsFee[];
  /** Count of `bidderBindings`. */
  collectors: number;
  /** Whole-card market price (USDC, lib/pricing's quoteUsdc) by card id; null without one, missing while loading. */
  markets: ReadonlyMap<string, bigint | null>;
  /** Name and art by scryfall id (/api/cards/attributes). */
  attributes: Readonly<Record<string, { name?: string; image?: string | null }>>;
  block: bigint;
  now: number;
  range: AnalyticsRange;
};

// ---------------------------------------------------------------------------------------------------------------------
// Output

export type AnalyticsTiles = {
  /** Cards with state ≠ released, and those minted in the range. */
  cardsInVault: number;
  mintedInRange: number;
  /** Σ implied value (USDC) over sharded and auctioning cards with one. */
  valueLocked: bigint;
  /** Σ raised by graduated settles in the range, and how many. */
  raised: bigint;
  raisedAuctions: number;
  /** Σ fees to the vault in the range. */
  fees: bigint;
  /** Auctions with endBlock > block, and the blocks until the next ends (null with none). */
  liveAuctions: number;
  nextEndsIn: bigint | null;
  collectors: number;
};

export type AnalyticsView = {
  window: RangeWindow;
  tiles: AnalyticsTiles;
  treemap: TreemapItem[];
  premiums: LeaderboardRow[];
  languages: ShareRow[];
  volume: DailyPoint[];
  /** No card in the vault at all. */
  empty: boolean;
};

export const cardHref = (id: bigint) => `/app/cards/${id}?tab=analytics`;
const toUsd = (x: bigint) => Number(formatUnits(x, 6));
export const PREMIUM_ROWS = 4;

/** The latest checkpoint's clearing price per auction (by block). */
function latestClearing(checkpoints: readonly AnalyticsCheckpoint[]): Map<string, bigint> {
  const best = new Map<string, AnalyticsCheckpoint>();
  for (const c of checkpoints) {
    const k = lc(c.auction);
    const cur = best.get(k);
    if (!cur || c.blockNumber > cur.blockNumber) best.set(k, c);
  }
  return new Map([...best].map(([k, c]) => [k, c.clearingPriceQ96]));
}

type Entry = { card: AnalyticsCard; implied: bigint | null; market: bigint | null; premium: number | null; name: string; thumb?: string; live: boolean };

export function analyticsView(p: AnalyticsInput): AnalyticsView {
  const inVault = p.cards.filter((c) => c.state !== "released");
  const first = p.activities.reduce<number | null>((m, a) => (m == null || a.timestamp < m ? a.timestamp : m), null);
  const firstMint = inVault.reduce<number | null>((m, c) => (m == null || c.mintedAt < m ? c.mintedAt : m), null);
  const earliest = first == null ? firstMint : firstMint == null ? first : Math.min(first, firstMint);
  const window = rangeWindow(p.range, p.now, earliest);
  const inRange = (t: number) => t >= window.from && t <= window.to;

  // Shardings newest first, per card, so currentSharding falls back to the latest.
  const byCard = new Map<string, AnalyticsSharding[]>();
  for (const s of [...p.shardings].sort((a, b) => b.createdAt - a.createdAt)) {
    const k = s.cardId.toString();
    byCard.set(k, [...(byCard.get(k) ?? []), s]);
  }
  const live = latestClearing(p.checkpoints);

  const entries: Entry[] = [];
  for (const card of inVault) {
    if (card.state !== "sharded" && card.state !== "auctioning") continue;
    const s = currentSharding(card, byCard.get(card.id.toString()) ?? []);
    if (!s) continue;
    const implied = impliedValueUsdc(s, s.graduated === null ? (live.get(lc(s.auction)) ?? null) : null);
    const market = p.markets.get(card.id.toString()) ?? null;
    const a = p.attributes[card.scryfallId];
    entries.push({ card, implied, market, premium: premium(implied, market), name: a?.name || card.label, thumb: a?.image || undefined, live: s.graduated === null });
  }

  // n/a (no implied value: not graduated, or no clearing yet) is sized by the market so the tile still exists.
  const treemap: TreemapItem[] = entries.flatMap((e) => {
    const size = e.implied ?? e.market;
    if (size == null || size === 0n) return [];
    return [{
      id: e.card.id.toString(), name: e.name, value: toUsd(size), premium: e.implied == null ? null : e.premium, sizedByMarket: e.implied == null,
      href: cardHref(e.card.id), thumb: e.thumb, ensName: e.card.ensName, live: e.live && e.implied != null,
    }];
  });

  const premiums: LeaderboardRow[] = entries
    .filter((e): e is Entry & { premium: number } => e.implied != null && e.premium != null)
    .sort((a, b) => b.premium - a.premium)
    .slice(0, PREMIUM_ROWS)
    .map((e, i) => ({
      rank: i + 1, label: e.name, thumb: e.thumb, href: cardHref(e.card.id), value: premiumLabel(e.premium), live: e.live,
      tone: Math.abs(e.premium) < PREMIUM_NEUTRAL ? "neutral" : e.premium > 0 ? "pos" : "neg",
    }));

  const langs = new Map<string, number>();
  for (const c of inVault) {
    const k = languageName(c.language);
    langs.set(k, (langs.get(k) ?? 0) + 1);
  }
  const languages = [...langs].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const settles = p.activities.filter((a) => a.kind === "settle" && a.amount != null && (a.meta as { graduated?: boolean } | null)?.graduated !== false && inRange(a.timestamp));
  const liveActive = p.active.filter((a) => a.endBlock > p.block);
  const nextEnd = liveActive.reduce<bigint | null>((m, a) => (m == null || a.endBlock < m ? a.endBlock : m), null);

  const buckets = bucketSeries(p.activities, new Date(window.from * 1000), new Date(window.to * 1000), window.unit);
  return {
    window,
    tiles: {
      cardsInVault: inVault.length,
      mintedInRange: inVault.filter((c) => inRange(c.mintedAt)).length,
      valueLocked: entries.reduce((a, e) => a + (e.implied ?? 0n), 0n),
      raised: settles.reduce((a, s) => a + (s.amount ?? 0n), 0n),
      raisedAuctions: settles.length,
      fees: p.fees.filter((f) => inRange(f.timestamp)).reduce((a, f) => a + f.amountUsdc, 0n),
      liveAuctions: liveActive.length,
      nextEndsIn: nextEnd == null ? null : nextEnd - p.block,
      collectors: p.collectors,
    },
    treemap,
    premiums,
    languages,
    volume: buckets.map((b) => ({ date: b.date, value: toUsd(b.volumeUsdc) })),
    empty: inVault.length === 0,
  };
}

/** The "Cards in vault" sub line: "+4 this week", "+1 in 24h", "23 minted". */
export function mintedSub(range: AnalyticsRange, n: number): string {
  if (range === "all") return `${n} minted`;
  return `+${n} ${range === "24h" ? "in 24h" : "this week"}`;
}
