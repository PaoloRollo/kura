// Pure card-page derivations (holders, ENS profile, header lines): no React, so node tests can cover them.
import { q96ToUsdcPerShard } from "@kura/shared";

const ZERO = "0x0000000000000000000000000000000000000000";
const SHARD = 10n ** 18n;
const lc = (a: string) => a.toLowerCase();

type Address = `0x${string}`;
type Balance = { holder: Address; balance: bigint };
type Transfer = { id: string; from: Address; to: Address; shardToken: Address; blockNumber: bigint; timestamp: number };
type Sharding = { auction: Address; shardToken: Address; graduated: boolean | null; clearingPriceQ96: bigint | null };

/** Holder chart colours in holder order (balance desc), as the designs use them; s2 and s5 come after. */
export const HOLDER_COLORS = ["var(--kura-s1)", "var(--kura-s3)", "var(--kura-s4)", "var(--kura-s7)", "var(--kura-s2)", "var(--kura-s5)"] as const;
export const holderColor = (i: number) => HOLDER_COLORS[i % HOLDER_COLORS.length]!;

/** Addresses that hold shards on the card's behalf, not as owners: every auction of the card, and the vault. */
export function custodians(shardings: readonly Pick<Sharding, "auction">[], vault: string): Set<string> {
  return new Set([lc(vault), ...shardings.map((s) => lc(s.auction))]);
}

/**
 * The card's current sharding: the one its shard token points at, else the latest. None once the card is whole again
 * (after a buyout the latest sharding's token is burned; its holders and auction are history, not the present).
 */
export function currentSharding<T extends { shardToken: string }>(card: { state: string; shardToken: string | null } | null, shardings: readonly T[]): T | null {
  if (!card || card.state === "whole") return null;
  return shardings.find((s) => card.shardToken && lc(s.shardToken) === lc(card.shardToken)) ?? shardings[0] ?? null;
}

type ActivityLike = { kind: string; timestamp: number; txHash: string; meta: unknown };

/** For a whole card that was sharded before: the sharding that was bought out (latest with a redeemer) and its redeem. */
export function lastBuyout<S extends { shardToken: string; redeemer: string | null }, A extends ActivityLike>(
  card: { state: string },
  shardings: readonly S[],
  activities: readonly A[],
): { sharding: S; redeem: A | null } | null {
  if (card.state !== "whole") return null;
  const sharding = shardings.find((s) => s.redeemer != null);
  if (!sharding) return null;
  const redeem = activities.find((a) => a.kind === "redeem" && lc(String((a.meta as { shardToken?: string } | null)?.shardToken ?? "")) === lc(sharding.shardToken)) ?? null;
  return { sharding, redeem };
}

/** Redemption needs one holder at 80% of the supply: `balance * 5 >= supply * 4` (the contract's rule). */
export const canRedeem = (balance: bigint, supply: bigint) => supply > 0n && balance * 5n >= supply * 4n;

/** Where a holder's shards came from: the earliest inbound transfer of `token` to them. */
export type Since = { kind: "sharded" | "auction" | "from"; from: Address; timestamp: number } | null;

export function holderSince(holder: string, token: string, transfers: readonly Transfer[], auctions: ReadonlySet<string>): Since {
  let first: Transfer | null = null;
  for (const tr of transfers) {
    if (lc(tr.to) !== lc(holder) || lc(tr.shardToken) !== lc(token)) continue;
    if (!first || tr.blockNumber < first.blockNumber || (tr.blockNumber === first.blockNumber && logIndexOf(tr.id) < logIndexOf(first.id))) first = tr;
  }
  if (!first) return null;
  const kind = lc(first.from) === ZERO ? "sharded" : auctions.has(lc(first.from)) ? "auction" : "from";
  return { kind, from: first.from, timestamp: first.timestamp };
}

/** `"<txHash>-<logIndex>"` (the indexer's logId) → its parts. */
export function parseLogId(id: string): { txHash: Address; logIndex: number } {
  const i = id.lastIndexOf("-");
  return { txHash: id.slice(0, i) as Address, logIndex: Number(id.slice(i + 1)) };
}
const logIndexOf = (id: string) => parseLogId(id).logIndex;

export type HolderRow = {
  holder: Address;
  balance: bigint;
  /** balance / supply, 0..1 */
  share: number;
  color: string;
  /** balance × clearing price, or null when the auction did not graduate (or has no price yet). */
  value: bigint | null;
  canRedeem: boolean;
  since: Since;
};

export type HoldersView = {
  rows: HolderRow[];
  supply: bigint;
  /** Shards still held by the card's auction(s): bought but not claimed yet. */
  unclaimed: bigint;
  /** Σ share² over the displayed holders. */
  hhi: number;
  top: HolderRow | null;
  /** USDC per whole shard at clearing; null when not graduated or unknown. */
  clearingPerShard: bigint | null;
};

/** The clearing price per shard used for holder values: n/a when the auction did not graduate. */
export function clearingPerShard(s: Pick<Sharding, "graduated" | "clearingPriceQ96"> | null): bigint | null {
  if (!s || s.graduated === false || s.clearingPriceQ96 == null) return null;
  return q96ToUsdcPerShard(s.clearingPriceQ96);
}

/**
 * The Holders view. `supply` counts every balance (auction and vault included), which is ShardToken.totalSupply() and
 * what the 80% rule uses; only the display leaves the auction(s) and the vault out.
 */
export function holdersView(p: {
  balances: readonly Balance[];
  sharding: (Sharding & { shardToken: Address }) | null;
  shardings: readonly Sharding[];
  transfers: readonly Transfer[];
  vault: string;
}): HoldersView {
  const live = p.balances.filter((b) => b.balance > 0n);
  const supply = live.reduce((a, b) => a + b.balance, 0n);
  const excluded = custodians(p.shardings, p.vault);
  const auctions = new Set(p.shardings.map((s) => lc(s.auction)));
  const price = clearingPerShard(p.sharding);
  const token = p.sharding?.shardToken ?? ZERO;
  const shown = live.filter((b) => !excluded.has(lc(b.holder))).sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  const rows: HolderRow[] = shown.map((b, i) => ({
    holder: b.holder,
    balance: b.balance,
    share: shareOf(b.balance, supply),
    color: holderColor(i),
    value: price == null ? null : (b.balance * price) / SHARD,
    canRedeem: canRedeem(b.balance, supply),
    since: holderSince(b.holder, token, p.transfers, auctions),
  }));
  const unclaimed = live.filter((b) => auctions.has(lc(b.holder))).reduce((a, b) => a + b.balance, 0n);
  const hhi = rows.reduce((a, r) => a + r.share * r.share, 0);
  return { rows, supply, unclaimed, hhi, top: rows[0] ?? null, clearingPerShard: price };
}

/** A share 0..1 with 1e-6 precision (bigint-safe for 18-decimal balances). */
export function shareOf(balance: bigint, supply: bigint): number {
  return supply > 0n ? Number((balance * 1_000_000n) / supply) / 1_000_000 : 0;
}

/** "81.3%" */
export const pct = (share: number, dp = 1) => `${(share * 100).toFixed(dp)}%`;

// ---------------------------------------------------------------------------------------------------------------------
// ENS profile

export type RecordRole = "vendor" | "appraiser" | "vault";

/**
 * Who may write a text key, from CardNames.authorizeTextRoles: the vendor writes condition and grade, the appraiser
 * the appraisal, the vault everything else. Derived from the key, never from `setBy` (a relayer under sponsorship).
 */
export function recordRole(key: string): RecordRole {
  if (key === "condition" || key === "grade") return "vendor";
  if (key === "appraisal.usd" || key === "appraisal.at") return "appraiser";
  return "vault";
}

/** The keys the On-chain profile shows first, in this order; the rest follow alphabetically. */
export const PROFILE_FIRST = ["condition", "language", "vault.state", "vault.clearing_usdc", "appraisal.usd"] as const;

export function orderRecords<T extends { key: string }>(records: readonly T[]): T[] {
  const rank = (k: string) => {
    const i = (PROFILE_FIRST as readonly string[]).indexOf(k);
    return i === -1 ? PROFILE_FIRST.length : i;
  };
  return [...records].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------------------------------------------------
// Time

/** Compact age, the way activity rows show it: "now", "2m", "3h", "7d". */
export function ago(timestamp: number, now: number): string {
  const s = Math.max(0, now - timestamp);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Long age for sentences: "22 min ago", "3 h ago", "2 days ago". */
export function agoLong(timestamp: number, now: number): string {
  const s = Math.max(0, now - timestamp);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** "Sep 26, 16:04" in the viewer's time zone. */
export function dateTime(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date}, ${time}`;
}

const SECONDS_PER_BLOCK = 12;

/** An auction length in blocks, in words at 12 s per block: "1 week", "3 days", "6 hours", "45 min". */
export function blocksToDuration(blocks: bigint): string {
  const s = Number(blocks) * SECONDS_PER_BLOCK;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (s >= 7 * 86_400 && s % (7 * 86_400) === 0) return plural(s / (7 * 86_400), "week");
  if (s >= 86_400) return plural(Math.round(s / 86_400), "day");
  if (s >= 3600) return plural(Math.round(s / 3600), "hour");
  return `${Math.max(1, Math.round(s / 60))} min`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Identity

/** "LEA · Rare" from attributes (or meta traits). */
export function setRarity(set: string | undefined, rarity: string | undefined): string | null {
  if (!set && !rarity) return null;
  const r = rarity ? rarity.charAt(0).toUpperCase() + rarity.slice(1) : "";
  return [set?.toUpperCase(), r].filter(Boolean).join(" · ");
}

/** Whole shards from 18-decimal units, for "16 shards". */
export const wholeShards = (units: bigint) => units / SHARD;

// ---------------------------------------------------------------------------------------------------------------------
// Tabs

export const CARD_TABS = [
  { value: "overview", label: "Overview" },
  { value: "auction", label: "Auction" },
  { value: "holders", label: "Holders" },
  { value: "activity", label: "Activity" },
  { value: "analytics", label: "Analytics" },
] as const;
export type CardTab = (typeof CARD_TABS)[number]["value"];

/** `?tab=` → a tab, Overview when missing or unknown. */
export function parseTab(v: string | null | undefined): CardTab {
  return CARD_TABS.find((t) => t.value === v)?.value ?? "overview";
}
