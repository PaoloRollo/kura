// The dashboard's "Recent vault events · via MultiBaas" panel, pure: the newest CardVault events MultiBaas holds (from
// the same four saved list queries the 24h figures read), with when MultiBaas started indexing the vault. Amounts stay
// bigint base units, decimal strings on the wire. A row of another shape throws MbShapeError, and the panel is hidden.
import { z } from "zod";
import { MbShapeError, baseUnits, flag, unixSeconds, type MbRow } from "@/lib/multibaas/figures";

export const RECENT_LIMIT = 10;

export type RecentKind = "mint" | "settle" | "redeem" | "fee";
export type FeeKind = "sale" | "buyout";

export type RecentEvent = {
  kind: RecentKind;
  card: bigint;
  /** triggered_at, unix seconds. */
  at: number;
  block: number;
  tx: string;
  /** settle: raised (0 when it did not graduate); redeem: payout; fee: the fee; mint: null. */
  amount: bigint | null;
  /** settle only. */
  graduated: boolean | null;
  /** fee only: CardVault.FeeKind (0 Sale, 1 Buyout). */
  feeKind: FeeKind | null;
};

/**
 * Where MultiBaas's copy of the vault starts: the linked contract's startBlockNumber, its time (estimated from the
 * chain head at 12 s a block, so never earlier than the truth), and whether that reaches back to the vault's deployment.
 */
export type MultibaasCoverage = { startBlock: number; since: number; fromDeploy: boolean };

export type MultibaasRecent = {
  coverage: MultibaasCoverage;
  /** Newest first, at most RECENT_LIMIT. */
  events: RecentEvent[];
  /** Every event MultiBaas holds across the four queries. */
  total: number;
};

export type RecentRows = { settles: readonly MbRow[]; redeems: readonly MbRow[]; mints: readonly MbRow[]; fees: readonly MbRow[] };

const describe = (v: unknown) => (typeof v === "string" ? JSON.stringify(v.slice(0, 40)) : typeof v);
const blockOf = (v: unknown, field: string): number => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d{1,15}$/.test(v)) return Number(v);
  throw new MbShapeError(`${field}: expected a block number, got ${describe(v)}`);
};
const txOf = (v: unknown, field: string): string => {
  if (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return v.toLowerCase();
  throw new MbShapeError(`${field}: expected a transaction hash, got ${describe(v)}`);
};
const feeKindOf = (v: unknown, field: string): FeeKind => {
  const n = baseUnits(v, field);
  if (n === 0n) return "sale";
  if (n === 1n) return "buyout";
  throw new MbShapeError(`${field}: expected a fee kind (0 or 1), got ${n}`);
};

const base = (kind: RecentKind, r: MbRow, i: number) => ({
  kind,
  card: baseUnits(r.card, `${kind}.card[${i}]`),
  at: unixSeconds(r.at, `${kind}.at[${i}]`),
  block: blockOf(r.block, `${kind}.block[${i}]`),
  tx: txOf(r.tx, `${kind}.tx[${i}]`),
});

// Within one transaction CardVault emits the settle or buyout first and its FeeAccrued after (CardVault.sol settle,
// redeem), so newest first puts the fee above it; a mint never shares a transaction with them.
const RANK: Record<RecentKind, number> = { fee: 0, settle: 1, redeem: 1, mint: 2 };

/** Every row is parsed (not only the newest), so a shape change anywhere hides the panel instead of half-rendering. */
export function recentFromRows(rows: RecentRows, coverage: MultibaasCoverage, limit = RECENT_LIMIT): MultibaasRecent {
  const events: RecentEvent[] = [
    ...rows.mints.map((r, i) => ({ ...base("mint", r, i), amount: null, graduated: null, feeKind: null })),
    ...rows.settles.map((r, i) => ({ ...base("settle", r, i), amount: baseUnits(r.raised, `settle.raised[${i}]`), graduated: flag(r.graduated, `settle.graduated[${i}]`), feeKind: null })),
    ...rows.redeems.map((r, i) => ({ ...base("redeem", r, i), amount: baseUnits(r.payout, `redeem.payout[${i}]`), graduated: null, feeKind: null })),
    ...rows.fees.map((r, i) => ({ ...base("fee", r, i), amount: baseUnits(r.amount, `fee.amount[${i}]`), graduated: null, feeKind: feeKindOf(r.kind, `fee.kind[${i}]`) })),
  ];
  events.sort((a, b) => b.block - a.block || b.at - a.at || RANK[a.kind] - RANK[b.kind]);
  return { coverage, events: events.slice(0, limit), total: events.length };
}

/**
 * When the 24h tiles can switch to MultiBaas: the first whole hour whose 24h window (lib/analytics-view rangeWindow:
 * 23 whole hours before the current one) starts after `since`. Null when MultiBaas indexed the vault from its deployment.
 */
export function fullDayCoveredAt(c: MultibaasCoverage): number | null {
  if (c.fromDeploy) return null;
  return Math.ceil(c.since / 3600) * 3600 + 23 * 3600;
}

// ---------------------------------------------------------------------------------------------------------------------
// Wire

export type MultibaasRecentWire = {
  source: "multibaas";
  view: "recent";
  coverage: MultibaasCoverage;
  total: number;
  events: { kind: RecentKind; card: string; at: number; block: number; tx: string; amount: string | null; graduated: boolean | null; feeKind: FeeKind | null }[];
};

export const recentToWire = (r: MultibaasRecent): MultibaasRecentWire => ({
  source: "multibaas",
  view: "recent",
  coverage: { startBlock: r.coverage.startBlock, since: r.coverage.since, fromDeploy: r.coverage.fromDeploy },
  total: r.total,
  events: r.events.map((e) => ({
    kind: e.kind, card: e.card.toString(), at: e.at, block: e.block, tx: e.tx,
    amount: e.amount == null ? null : e.amount.toString(), graduated: e.graduated, feeKind: e.feeKind,
  })),
});

const units = z.string().regex(/^\d+$/).transform((s) => BigInt(s));
const int = z.number().int().nonnegative();
const Wire = z.object({
  source: z.literal("multibaas"),
  view: z.literal("recent"),
  coverage: z.object({ startBlock: int, since: int, fromDeploy: z.boolean() }),
  total: int,
  events: z.array(z.object({
    kind: z.enum(["mint", "settle", "redeem", "fee"]),
    card: units,
    at: int,
    block: int,
    tx: z.string().regex(/^0x[0-9a-f]+$/),
    amount: units.nullable(),
    graduated: z.boolean().nullable(),
    feeKind: z.enum(["sale", "buyout"]).nullable(),
  })).max(RECENT_LIMIT),
});

/** The route's `?view=recent` answer, or null for anything else (an error body, a malformed amount). */
export function recentFromWire(json: unknown): MultibaasRecent | null {
  const p = Wire.safeParse(json);
  if (!p.success) return null;
  const { coverage, total, events } = p.data;
  return { coverage, total, events: events.map((e) => ({ ...e })) };
}
