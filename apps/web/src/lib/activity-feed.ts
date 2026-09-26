// The card's merged activity feed: indexer activities, shard transfers between holders and ENS record writes, in
// (blockNumber, logIndex) order, with the row text per kind. Pure, so node tests cover it.
import { blocksToDuration, custodians, parseLogId, recordRole } from "@/lib/card-view";
import { money, shardsFixed } from "@/lib/format";

type Hex = `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a: string) => a.toLowerCase();

type Activity = {
  id: string;
  kind: "mint" | "shard" | "bid" | "exit" | "claim" | "settle" | "redeem" | "payout" | "release" | "named" | "transfer";
  actor: Hex;
  amount: bigint | null;
  meta: unknown;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  timestamp: number;
};
type Transfer = { id: string; shardToken: Hex; from: Hex; to: Hex; amount: bigint; blockNumber: bigint; timestamp: number };
type Record_ = { key: string; value: string; updatedBlock: bigint; updatedAt: number };
type Sharding = { shardToken: Hex; auction: Hex; startBlock: bigint; endBlock: bigint; feeUsdc: bigint | null };

export type FeedKind = Activity["kind"] | "shardTransfer" | "record";
/** Row text: plain strings, or an address rendered by its Kura name. */
export type Part = string | { address: Hex };

export type FeedRow = {
  key: string;
  kind: FeedKind;
  title: string;
  who: Part[];
  /** The Overview list's shorter who ("Minted · vendor", "Settled · kenji.kura.eth"). */
  whoShort: Part[];
  detail: Part[];
  /** Null for ENS records (the indexer keeps only the latest value, without its transaction). */
  txHash: Hex | null;
  blockNumber: bigint;
  logIndex: number;
  timestamp: number;
};

export const FEED_FILTERS = ["all", "bids", "transfers", "settlement", "ens"] as const;
export type FeedFilter = (typeof FEED_FILTERS)[number];
export const FILTER_LABELS: Record<FeedFilter, string> = { all: "All", bids: "Bids", transfers: "Transfers", settlement: "Settlement", ens: "ENS" };

/** Which filter each kind belongs to; mint shows under All only. */
const FILTER_OF: Record<FeedKind, FeedFilter | null> = {
  bid: "bids", exit: "bids", claim: "bids",
  transfer: "transfers", shardTransfer: "transfers",
  shard: "settlement", settle: "settlement", redeem: "settlement", payout: "settlement", release: "settlement",
  named: "ens", record: "ens",
  mint: null,
};

export const filterFeed = (rows: readonly FeedRow[], f: FeedFilter) => (f === "all" ? [...rows] : rows.filter((r) => FILTER_OF[r.kind] === f));

const TITLES: Record<FeedKind, string> = {
  mint: "Minted", named: "Named", shard: "Sharded", bid: "Bid", exit: "Exited", claim: "Claimed", settle: "Settled",
  redeem: "Redeemed", payout: "Payout", release: "Released", transfer: "Transfer", shardTransfer: "Transfer", record: "ENS record",
};

/** USDC the way the rows show it: whole dollars without cents ("$1,712"), otherwise two decimals ("$128.40"). */
export const usd = (x: bigint) => (x % 1_000_000n === 0n ? money(x, 0) : money(x));
const big = (v: unknown): bigint | null => {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  return null;
};
const sh = (units: bigint) => `${shardsFixed(units)} shards`;

export type FeedContext = {
  shardings: readonly Sharding[];
  /** The card's ENS name, for "Named" rows. */
  ensName: string;
  parties: { vendor: string; signer: string; cardVault: string };
};

/** A role label in front ("vendor · kura.eth") is enough on its own; "anyone" (permissionless settle) is dropped. */
function shortWho(who: Part[]): Part[] {
  const [first, ...rest] = who;
  if (first === "anyone") return rest;
  if (typeof first === "string" && first !== "→") return [first];
  return who;
}

function describe(a: Activity, ctx: FeedContext): { who: Part[]; detail: Part[] } {
  const m = (a.meta ?? {}) as Record<string, unknown>;
  const actor = { address: a.actor };
  const sharding = typeof m.shardToken === "string" ? ctx.shardings.find((s) => lc(s.shardToken) === lc(m.shardToken as string)) : undefined;
  switch (a.kind) {
    case "bid": {
      const max = big(m.maxUsdcPerShard);
      return { who: [actor], detail: [[a.amount != null ? usd(a.amount) : null, max != null ? `up to ${usd(max)}` : null].filter(Boolean).join(" ")] };
    }
    case "exit": {
      const filled = big(m.tokensFilled);
      return { who: [actor], detail: [[filled != null ? `filled ${sh(filled)}` : null, a.amount != null ? `refund ${usd(a.amount)}` : null].filter(Boolean).join(" · ")] };
    }
    case "claim":
      return { who: [actor], detail: [a.amount != null ? sh(a.amount) : ""] };
    case "shard": {
      const parts = [`${String(m.totalShards ?? "?")} shards`, `${String(m.forSale ?? "?")} for sale`];
      if (sharding) parts.push(blocksToDuration(sharding.endBlock - sharding.startBlock));
      return { who: [actor], detail: [parts.join(" · ")] };
    }
    case "settle": {
      if (m.graduated === false) return { who: ["anyone", actor], detail: ["Reserve not met · refunded"] };
      const parts = [`raised ${usd(a.amount ?? 0n)}`];
      if (sharding?.feeUsdc != null) parts.push(`fee ${usd(sharding.feeUsdc)}`);
      return { who: ["anyone", actor], detail: [parts.join(" · ")] };
    }
    case "redeem": {
      const b = big(m.buyoutPerShard);
      return { who: [actor], detail: [[b != null ? `buyout ${usd(b)}/shard` : null, `paid ${usd(a.amount ?? 0n)}`].filter(Boolean).join(" · ")] };
    }
    case "payout": {
      const units = big(m.shardUnits);
      return { who: [actor], detail: [`${usd(a.amount ?? 0n)}${units != null ? ` for ${sh(units)}` : ""}`] };
    }
    case "named": {
      const label = typeof m.label === "string" ? m.label : "";
      return { who: [{ address: ctx.parties.cardVault as Hex }], detail: [label && ctx.ensName.startsWith(`${label}.`) ? ctx.ensName : label] };
    }
    case "mint":
      return { who: ["vendor", { address: ctx.parties.vendor as Hex }], detail: ["to", actor] };
    case "transfer":
      return { who: [actor, "→", ...(typeof m.to === "string" ? [{ address: m.to as Hex }] : [])], detail: ["whole card"] };
    case "release":
      return { who: [actor], detail: ["picked up at the vault"] };
  }
}

/** Who may write a record key, as a row's "who": the vendor, the appraiser or the vault. */
function recordWho(key: string, parties: FeedContext["parties"]): Part[] {
  const role = recordRole(key);
  if (role === "vendor") return ["vendor", { address: parties.vendor as Hex }];
  if (role === "appraiser") return [{ address: parties.signer as Hex }];
  return [{ address: parties.cardVault as Hex }];
}

/**
 * The merged feed, newest first by (blockNumber, logIndex):
 * - every activity of the card;
 * - shard transfers of all its shardings' tokens, except mints, burns and moves from or to its auctions or the vault
 *   (claims, settlement and payouts already cover those);
 * - ENS records, placed at their updatedBlock after that block's logs (by key among themselves), without a transaction.
 */
export function buildFeed(p: { activities: readonly Activity[]; transfers: readonly Transfer[]; records: readonly Record_[]; ctx: FeedContext }): FeedRow[] {
  const excluded = custodians(p.ctx.shardings, p.ctx.parties.cardVault);
  const tokens = new Set(p.ctx.shardings.map((s) => lc(s.shardToken)));
  const rows: FeedRow[] = p.activities.map((a) => {
    const d = describe(a, p.ctx);
    return { key: a.id, kind: a.kind, title: TITLES[a.kind], ...d, whoShort: shortWho(d.who), txHash: a.txHash, blockNumber: a.blockNumber, logIndex: a.logIndex, timestamp: a.timestamp };
  });
  for (const t of p.transfers) {
    if (!tokens.has(lc(t.shardToken))) continue;
    if (lc(t.from) === ZERO || lc(t.to) === ZERO || excluded.has(lc(t.from)) || excluded.has(lc(t.to))) continue;
    const { txHash, logIndex } = parseLogId(t.id);
    rows.push({
      key: t.id, kind: "shardTransfer", title: TITLES.shardTransfer, who: [{ address: t.from }, "→", { address: t.to }], whoShort: [{ address: t.from }, "→", { address: t.to }], detail: [sh(t.amount)],
      txHash, blockNumber: t.blockNumber, logIndex, timestamp: t.timestamp,
    });
  }
  for (const r of p.records) {
    const who = recordWho(r.key, p.ctx.parties);
    rows.push({
      key: `record-${r.key}`, kind: "record", title: TITLES.record, who, whoShort: shortWho(who), detail: [`${r.key} = ${r.value}`],
      txHash: null, blockNumber: r.updatedBlock, logIndex: Number.MAX_SAFE_INTEGER, timestamp: r.updatedAt,
    });
  }
  // Records share a block's end position; among themselves they go by key, so the order is stable.
  return rows.sort((a, b) =>
    a.blockNumber !== b.blockNumber ? (a.blockNumber > b.blockNumber ? -1 : 1) : b.logIndex - a.logIndex || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------------------------------------------------
// Pagination

export const PAGE_SIZES = [10, 25, 50] as const;

export function pageOf<T>(rows: readonly T[], page: number, size: number) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, page), pages);
  const start = (p - 1) * size;
  const items = rows.slice(start, start + size);
  return { items, page: p, pages, from: rows.length === 0 ? 0 : start + 1, to: start + items.length, total: rows.length };
}

/** Page buttons with gaps: 1 2 3 … 6, 1 … 4 5 6 … 9. */
export function pageWindow(page: number, pages: number): (number | "gap")[] {
  if (pages <= 5) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3].forEach((n) => keep.add(n));
  if (page >= pages - 2) [pages - 1, pages - 2].forEach((n) => keep.add(n));
  const sorted = [...keep].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1]! > 1) out.push("gap");
    out.push(n);
  });
  return out;
}
