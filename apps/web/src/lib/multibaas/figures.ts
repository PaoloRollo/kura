// The analytics figures MultiBaas's saved Event Queries answer (raised, fees, mints, volume), from the query rows, pure:
// the server route computes them, the dashboard parses them back. USDC amounts (6 decimals) stay bigint base units end
// to end, and are decimal strings on the wire, never JSON numbers. A value that is not a base-unit integer (a MultiBaas
// type conversion adds decimals; a JSON number past 2^53 has already lost precision inside res.json()) throws
// MbShapeError, and the dashboard then shows the indexer's figures instead of a wrong one.
import { z } from "zod";
import { rangeWindow, type AnalyticsRange, type RangeWindow } from "@/lib/analytics-view";
import { bucketSeries } from "@/lib/series";

export class MbShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MbShapeError";
  }
}

const describe = (v: unknown) => (typeof v === "string" ? JSON.stringify(v.slice(0, 40)) : typeof v === "number" ? String(v) : typeof v);

/**
 * A USDC amount in base units: a decimal integer string (any size, exact), or a JSON number only while it is a safe
 * integer. An unsafe number is refused even when it looks whole: it may already be the rounded neighbour of the value.
 */
export function baseUnits(v: unknown, field: string): bigint {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new MbShapeError(`${field}: expected a base-unit integer, got ${describe(v)}`);
}

// RFC 3339 date-time (what triggered_at looks like): a date, a time, optional fraction, and a Z or an offset, which may
// also come Postgres-style (+00, +0000) since MultiBaas stores events in Postgres. Date.parse alone is lenient ("Sep 24
// 2026", bare dates, digit strings), so the shape is checked first and the offset normalised to ±hh:mm.
const RFC3339 = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:([Zz])|([+-]\d{2})(?::?(\d{2}))?)$/;
/** Unix seconds stay below 1e11 (year 5138); a larger number is a millisecond timestamp, refused rather than misread. */
const MAX_UNIX_SECONDS = 1e11;
const seconds = (n: number) => Number.isSafeInteger(n) && n >= 0 && n < MAX_UNIX_SECONDS;

/**
 * triggered_at as unix seconds: RFC 3339 (Z, ±hh:mm, or Postgres's ±hh / ±hhmm), unix seconds as a non-negative
 * integer, or unix seconds as a digit string of at most 11 digits. Milliseconds (≥ 1e11) are refused.
 */
export function unixSeconds(v: unknown, field = "at"): number {
  if (typeof v === "number" && seconds(v)) return v;
  if (typeof v === "string" && /^\d{1,11}$/.test(v) && seconds(Number(v))) return Number(v);
  const m = typeof v === "string" ? RFC3339.exec(v) : null;
  if (m) {
    const ms = Date.parse(`${m[1]}T${m[2]}${m[3] ? "Z" : `${m[4]}:${m[5] ?? "00"}`}`);
    if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms / 1000);
  }
  throw new MbShapeError(`${field}: expected a timestamp, got ${describe(v)}`);
}

export function flag(v: unknown, field: string): boolean {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  throw new MbShapeError(`${field}: expected a boolean, got ${describe(v)}`);
}

export type MbRow = Readonly<Record<string, unknown>>;
/** Rows of the six saved queries (packages/shared EVENT_QUERIES), by MB_QUERIES key. */
export type MbRows = {
  settles: readonly MbRow[];
  redeems: readonly MbRow[];
  mints: readonly MbRow[];
  fees: readonly MbRow[];
  raisedTotal: readonly MbRow[];
  feesTotal: readonly MbRow[];
};

export type MultibaasFigures = {
  range: AnalyticsRange;
  window: RangeWindow;
  /** Σ raisedUsdc of graduated settles in the window (All: MultiBaas's add aggregate), and how many. */
  raised: bigint;
  raisedAuctions: number;
  /** Σ FeeAccrued in the window (All: MultiBaas's add aggregate). */
  fees: bigint;
  /**
   * CardMinted events in the window: an event count, so a card minted and released since is counted too (the
   * indexer's "Cards in vault" sub line counts only cards still in the vault).
   */
  mintedInRange: number;
  /** Every CardMinted MultiBaas still holds (it keeps 72 h, from when the vault was linked); informational only. */
  totalMints: number;
  volume: { date: string; volumeUsdc: bigint }[];
};

const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);
const aggregate = (rows: readonly MbRow[], alias: string) => sum(rows.map((r, i) => baseUnits(r[alias], `${alias}[${i}]`)));

/** Every row is parsed, in the window or not, so a shape change anywhere refuses the whole answer. */
export function figuresFromRows(rows: MbRows, range: AnalyticsRange, now: number): MultibaasFigures {
  const settles = rows.settles.map((r, i) => ({ at: unixSeconds(r.at, `at[${i}]`), raised: baseUnits(r.raised, `raised[${i}]`), graduated: flag(r.graduated, `graduated[${i}]`) }));
  const redeems = rows.redeems.map((r, i) => ({ at: unixSeconds(r.at, `at[${i}]`), payout: baseUnits(r.payout, `payout[${i}]`) }));
  const mints = rows.mints.map((r, i) => unixSeconds(r.at, `at[${i}]`));
  const fees = rows.fees.map((r, i) => ({ at: unixSeconds(r.at, `at[${i}]`), amount: baseUnits(r.amount, `amount[${i}]`) }));
  const raisedTotal = aggregate(rows.raisedTotal, "raised");
  const feesTotal = aggregate(rows.feesTotal, "fees");

  const times = [...mints, ...settles.map((s) => s.at), ...redeems.map((r) => r.at)];
  const first = times.reduce<number | null>((m, t) => (m == null || t < m ? t : m), null);
  const window = rangeWindow(range, now, first);
  const inRange = (t: number) => t >= window.from && t <= window.to;
  const won = settles.filter((s) => s.graduated && inRange(s.at));

  // lib/series' rule: volume = graduated settles (raised) + buyouts (payout).
  const activities = [
    ...settles.map((s) => ({ kind: "settle", amount: s.raised, actor: "", timestamp: s.at, meta: { graduated: s.graduated } })),
    ...redeems.map((r) => ({ kind: "redeem", amount: r.payout, actor: "", timestamp: r.at, meta: null })),
  ];
  const buckets = bucketSeries(activities, new Date(window.from * 1000), new Date(window.to * 1000), window.unit);

  return {
    range,
    window,
    raised: range === "all" ? raisedTotal : sum(won.map((s) => s.raised)),
    raisedAuctions: won.length,
    fees: range === "all" ? feesTotal : sum(fees.filter((f) => inRange(f.at)).map((f) => f.amount)),
    mintedInRange: mints.filter(inRange).length,
    totalMints: mints.length,
    volume: buckets.map((b) => ({ date: b.date, volumeUsdc: b.volumeUsdc })),
  };
}

export type MultibaasFiguresWire = Omit<MultibaasFigures, "raised" | "fees" | "volume"> & {
  source: "multibaas";
  raised: string;
  fees: string;
  volume: { date: string; volumeUsdc: string }[];
};

export const toWire = (f: MultibaasFigures): MultibaasFiguresWire => ({
  source: "multibaas",
  range: f.range,
  window: f.window,
  raised: f.raised.toString(),
  raisedAuctions: f.raisedAuctions,
  fees: f.fees.toString(),
  mintedInRange: f.mintedInRange,
  totalMints: f.totalMints,
  volume: f.volume.map((b) => ({ date: b.date, volumeUsdc: b.volumeUsdc.toString() })),
});

const units = z.string().regex(/^\d+$/).transform((s) => BigInt(s));
const count = z.number().int().nonnegative();
const Wire = z.object({
  source: z.literal("multibaas"),
  range: z.enum(["24h", "7d", "all"]),
  window: z.object({ from: z.number().int(), to: z.number().int(), unit: z.enum(["hour", "day"]) }),
  raised: units,
  raisedAuctions: count,
  fees: units,
  mintedInRange: count,
  totalMints: count,
  volume: z.array(z.object({ date: z.string(), volumeUsdc: units })),
});

/** The route's answer as figures, or null for anything else (an error body, a malformed or numeric amount). */
export function fromWire(json: unknown): MultibaasFigures | null {
  const p = Wire.safeParse(json);
  if (!p.success) return null;
  const d = p.data;
  return { range: d.range, window: d.window, raised: d.raised, raisedAuctions: d.raisedAuctions, fees: d.fees, mintedInRange: d.mintedInRange, totalMints: d.totalMints, volume: d.volume };
}
