// Time series for the analytics charts, pure.
import { q96ToUsdcPerShard } from "@kura/shared";
import { parseLogId } from "@/lib/card-view";

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a: string) => a.toLowerCase();

export type SeriesUnit = "hour" | "day";
export type SeriesBucket = { date: string; volumeUsdc: bigint; mints: number; newCollectors: number };
type ActivityRow = { kind: string; amount: bigint | null; actor: string; timestamp: number; meta?: unknown };

const STEP = { hour: 3_600, day: 86_400 } as const;
const bucketKey = (unixSeconds: number, unit: SeriesUnit) => new Date(unixSeconds * 1000).toISOString().slice(0, unit === "day" ? 10 : 13);

/**
 * Activities bucketed by UTC hour ("YYYY-MM-DDTHH") or day ("YYYY-MM-DD") from `from` through `to`, empty buckets
 * filled. Volume is "USDC through auctions and buyouts": settle (raised; nothing when not graduated) + redeem
 * (payout). Bids, exits and payouts are not counted: they are already inside those two.
 */
export function bucketSeries(rows: readonly ActivityRow[], from: Date, to: Date, unit: SeriesUnit): SeriesBucket[] {
  const step = STEP[unit];
  const start = Math.floor(from.getTime() / 1000 / step) * step;
  const end = Math.floor(to.getTime() / 1000);
  const buckets = new Map<string, SeriesBucket>();
  for (let s = start; s <= end; s += step) {
    const k = bucketKey(s, unit);
    buckets.set(k, { date: k, volumeUsdc: 0n, mints: 0, newCollectors: 0 });
  }
  for (const r of rows) {
    const b = buckets.get(bucketKey(r.timestamp, unit));
    if (!b) continue;
    const meta = (r.meta ?? null) as { graduated?: boolean; handle?: boolean } | null;
    if (r.kind === "settle" && r.amount && meta?.graduated !== false) b.volumeUsdc += r.amount;
    else if (r.kind === "redeem" && r.amount) b.volumeUsdc += r.amount;
    else if (r.kind === "mint") b.mints += 1;
    else if (r.kind === "named" && meta?.handle === true) b.newCollectors += 1;
  }
  return [...buckets.values()];
}

export const dailySeries = (rows: readonly ActivityRow[], from: Date, to: Date) => bucketSeries(rows, from, to, "day");

type TransferRow = { id: string; from: string; to: string; amount: bigint; blockNumber: bigint; timestamp: number };

/** Holder count after each block of transfers, in (blockNumber, logIndex) order. `exclude`: custodians; 0x0 always. */
export function holderSeries(transfers: readonly TransferRow[], exclude: Iterable<string>): { blockNumber: bigint; timestamp: number; holders: number }[] {
  const ex = new Set([ZERO, ...[...exclude].map(lc)]);
  const sorted = [...transfers].sort((a, b) => (a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : parseLogId(a.id).logIndex - parseLogId(b.id).logIndex));
  const bal = new Map<string, bigint>();
  const out: { blockNumber: bigint; timestamp: number; holders: number }[] = [];
  for (const [i, t] of sorted.entries()) {
    const f = lc(t.from), to = lc(t.to);
    if (!ex.has(f)) bal.set(f, (bal.get(f) ?? 0n) - t.amount);
    if (!ex.has(to)) bal.set(to, (bal.get(to) ?? 0n) + t.amount);
    const next = sorted[i + 1];
    if (next && next.blockNumber === t.blockNumber) continue; // one point per block: its last state
    out.push({ blockNumber: t.blockNumber, timestamp: t.timestamp, holders: [...bal.values()].filter((v) => v > 0n).length });
  }
  return out;
}

export type DemandLevel = { maxUsdcPerShard: bigint; levelUsdc: bigint; cumulativeUsdc: bigint };

/** Bids grouped by max price level, highest first, with the USDC at each level and cumulated down the book. */
export function demandCurve(bids: readonly { maxPriceQ96: bigint; amountUsdc: bigint }[]): DemandLevel[] {
  const levels = new Map<bigint, bigint>();
  for (const b of bids) levels.set(b.maxPriceQ96, (levels.get(b.maxPriceQ96) ?? 0n) + b.amountUsdc);
  const sorted = [...levels.entries()].sort(([a], [b]) => (b > a ? 1 : b < a ? -1 : 0));
  let cum = 0n;
  return sorted.map(([q96, level]) => {
    cum += level;
    return { maxUsdcPerShard: q96ToUsdcPerShard(q96), levelUsdc: level, cumulativeUsdc: cum };
  });
}

/** Index of the highest level at or below the clearing price (the highlighted row), or -1. */
export function clearingLevel(curve: readonly DemandLevel[], clearingUsdcPerShard: bigint | null): number {
  if (clearingUsdcPerShard == null) return -1;
  return curve.findIndex((l) => l.maxUsdcPerShard <= clearingUsdcPerShard);
}
