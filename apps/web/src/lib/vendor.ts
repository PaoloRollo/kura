import { isAddressEqual, parseEventLogs, type Address, type Log } from "viem";
import { abi } from "@kura/shared";
import { addresses } from "@/lib/chain";
import { usdc } from "@/lib/format";
import type { Revert } from "@/lib/tx-core";

// Pure helpers behind the vendor screens: inventory (tM3Hy), fees (xJ7vz) and the station stats (g3IDaw).

export type CardState = "whole" | "auctioning" | "sharded" | "released";
export type InventoryTab = "all" | "whole" | "sharded" | "released";
export const INVENTORY_TABS: { id: InventoryTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "whole", label: "Whole" },
  { id: "sharded", label: "Sharded" },
  { id: "released", label: "Released" },
];

const lower = (a: string | null | undefined) => (a ?? "").toLowerCase();

/** The Sharded tab holds cards on auction as well as sharded ones. */
export function inTab(state: CardState, tab: InventoryTab): boolean {
  if (tab === "all") return true;
  if (tab === "sharded") return state === "auctioning" || state === "sharded";
  return state === tab;
}

export function tabCounts(cards: { state: CardState }[]): Record<InventoryTab, number> {
  return {
    all: cards.length,
    whole: cards.filter((c) => inTab(c.state, "whole")).length,
    sharded: cards.filter((c) => inTab(c.state, "sharded")).length,
    released: cards.filter((c) => inTab(c.state, "released")).length,
  };
}

/** Per card: holders with a positive shard balance, not counting the card's auction or the vault. */
export function holderCounts(
  cards: { id: bigint; shardToken: string | null; auction: string | null }[],
  balances: { shardToken: string; holder: string; balance: bigint }[],
  vault: string,
): Map<bigint, number> {
  const out = new Map<bigint, number>();
  for (const c of cards) {
    if (!c.shardToken) continue;
    const token = lower(c.shardToken);
    const skip = new Set([lower(c.auction), lower(vault)]);
    out.set(c.id, balances.filter((b) => lower(b.shardToken) === token && b.balance > 0n && !skip.has(lower(b.holder))).length);
  }
  return out;
}

type ShardingLike = { cardId: bigint; createdAt: number; redeemer: string | null; updatedAt?: number };

function latestShardings<S extends ShardingLike>(shardings: S[]): Map<bigint, S> {
  const latest = new Map<bigint, S>();
  for (const s of shardings) {
    const prev = latest.get(s.cardId);
    if (!prev || s.createdAt > prev.createdAt) latest.set(s.cardId, s);
  }
  return latest;
}

/** Whole cards that came out of a buyout: their latest sharding (by createdAt) has a redeemer. */
export function awaitingHandover(cards: { id: bigint; state: CardState }[], shardings: ShardingLike[]): Set<bigint> {
  return new Set(redeemedAt(cards, shardings).keys());
}

/**
 * When each Whole card awaiting a handover was redeemed: its latest sharding's `updatedAt`, since the redeem is the
 * last event that writes a sharding. Null when the row carries no `updatedAt`.
 */
export function redeemedAt(cards: { id: bigint; state: CardState }[], shardings: ShardingLike[]): Map<bigint, number | null> {
  const latest = latestShardings(shardings);
  const out = new Map<bigint, number | null>();
  for (const c of cards) {
    const s = latest.get(c.id);
    if (c.state === "whole" && s?.redeemer) out.set(c.id, s.updatedAt ?? null);
  }
  return out;
}

/** Case-insensitive match on the card name, the ENS name or the owner (address or handle). */
export function matchesSearch(row: { name?: string; ensName: string; owner?: string }, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [row.name, row.ensName, row.owner].some((s) => s?.toLowerCase().includes(needle));
}

type Fee = { amountUsdc: bigint; timestamp: number };
const DAY = 86_400;

/** All fees, and those in the last seven days. `now` in unix seconds. */
export function feeTotals(fees: Fee[], now: number): { total: bigint; week: bigint } {
  let total = 0n;
  let week = 0n;
  for (const f of fees) {
    total += f.amountUsdc;
    if (f.timestamp >= now - 7 * DAY) week += f.amountUsdc;
  }
  return { total, week };
}

const utcDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

/** Sale and buyout fees per UTC day for the last `days` days (today last), empty days included. */
export function feesPerDay(
  fees: (Fee & { kind: "sale" | "buyout" })[],
  days: number,
  now: number,
): { day: string; sale: bigint; buyout: bigint }[] {
  const out = Array.from({ length: days }, (_, i) => ({ day: utcDay(now - (days - 1 - i) * DAY), sale: 0n, buyout: 0n }));
  const byDay = new Map(out.map((d) => [d.day, d]));
  for (const f of fees) {
    const d = byDay.get(utcDay(f.timestamp));
    if (d) d[f.kind] += f.amountUsdc;
  }
  return out;
}

/** A CSV cell: quoted when it holds a quote, comma or line break; a leading = + - @ is defused with ' (formula injection). */
function csvCell(raw: string): string {
  const s = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The fee ledger as CSV, one row per fee event. */
export function feesCsv(rows: (Fee & { id: string; cardId: bigint; kind: string; name?: string })[]): string {
  const head = "time,kind,card_id,card,amount_usdc,event_id";
  const body = rows.map((r) =>
    [new Date(r.timestamp * 1000).toISOString(), r.kind, r.cardId.toString(), r.name ?? "", usdc(r.amountUsdc), r.id].map(csvCell).join(","),
  );
  return [head, ...body].join("\n");
}

/** Short age for the ledger: "now", "22m", "2h", "3d". */
export function age(unix: number, now: number): string {
  const s = Math.max(0, now - unix);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < DAY) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / DAY)}d`;
}

/** The empty station's row (g3IDaw). "Today" is the UTC day, as on the fees page. */
export function stationStats(
  cards: { state: CardState; mintedAt: number }[],
  fees: Fee[],
  now: number,
): { mintedToday: number; inCustody: number; feesToday: bigint } {
  const midnight = Math.floor(now / DAY) * DAY;
  return {
    mintedToday: cards.filter((c) => c.mintedAt >= midnight).length,
    inCustody: cards.filter((c) => c.state !== "released").length,
    feesToday: fees.filter((f) => f.timestamp >= midnight).reduce((a, f) => a + f.amountUsdc, 0n),
  };
}

/** Why a mint was refused, in the vendor's words (g5bcZ). */
export function describeMintError(_e: unknown, revert: Revert): { title: string; body?: string } {
  const reason: Record<string, string> = {
    OnlyVendor: "Only the vendor wallet can mint. Sign in with the vendor wallet and try again.",
    InvalidLabel: "The card name or set code can't be used in an ENS name. Pick the printing again.",
    InvalidCondition: "The condition isn't one of NM, LP, MP, HP or DMG.",
    InvalidLanguage: "The language code isn't valid. Pick the language again.",
    ZeroAddress: "The owner address is empty. Scan the owner's QR again.",
  };
  const name = revert.inner?.name ?? revert.name;
  if (name && reason[name]) return { title: "The vault refused this mint", body: `${reason[name]} Nothing was minted.` };
  if (revert.hash) return { title: "The mint reverted", body: "It was mined but the vault rejected it. Nothing was minted." };
  if (/reject|denied|cancel/i.test(revert.message)) return { title: "Request cancelled", body: "The mint was not sent." };
  return { title: "Couldn't send the mint", body: revert.message };
}

/**
 * The CardMinted event in a mint receipt, taken only from logs the vault itself emitted: the same receipt carries ENS
 * registry and resolver logs, and any other contract could emit an event with the same signature.
 */
export function mintedFromLogs(logs: readonly Log[], vault: Address = addresses.cardVault): { id: bigint; label: string; to: Address } | null {
  const own = logs.filter((l) => isAddressEqual(l.address, vault));
  const [log] = parseEventLogs({ abi: abi.cardVault, eventName: "CardMinted", logs: own, strict: true });
  return log ? { id: log.args.id, label: log.args.label, to: log.args.to } : null;
}

/** The CardSharded event fields the confirmation needs. */
export type Sharded = { id: bigint; shardToken: Address; auction: Address; totalShards: number; forSale: number; startBlock: bigint; endBlock: bigint };

/**
 * The CardSharded event in a `shardAndAuction` receipt, taken only from logs the vault itself emitted: the same receipt
 * carries the vault's ERC-721 Transfer, the ShardToken's mints, the CCA's and factory's logs and the ENS state records.
 */
export function shardedFromLogs(logs: readonly Log[], cardId?: bigint, vault: Address = addresses.cardVault): Sharded | null {
  const own = logs.filter((l) => isAddressEqual(l.address, vault));
  const parsed = parseEventLogs({ abi: abi.cardVault, eventName: "CardSharded", logs: own, strict: true });
  const log = cardId === undefined ? parsed[0] : parsed.find((l) => l.args.id === cardId);
  if (!log) return null;
  const a = log.args;
  return { id: a.id, shardToken: a.shardToken, auction: a.auction, totalShards: a.totalShards, forSale: a.forSale, startBlock: a.startBlock, endBlock: a.endBlock };
}

export type MintOutcome =
  | { status: "minted"; hash: `0x${string}`; blockNumber: bigint; id: bigint; label: string; to: Address }
  | { status: "details-unavailable"; hash: `0x${string}`; reason: string };

/**
 * What a confirmed mint produced. Always terminal: once the mint transaction is confirmed the card exists, so a failure
 * to read its receipt or event yields "details-unavailable" with the hash, never an error the station could retry on.
 */
export async function mintOutcome(
  hash: `0x${string}`,
  getReceipt: (hash: `0x${string}`) => Promise<{ blockNumber: bigint; logs: readonly Log[] }>,
  read: (logs: readonly Log[]) => ReturnType<typeof mintedFromLogs> = mintedFromLogs,
): Promise<MintOutcome> {
  try {
    const receipt = await getReceipt(hash);
    const minted = read(receipt.logs);
    if (!minted) return { status: "details-unavailable", hash, reason: "The receipt has no CardMinted event from the vault." };
    return { status: "minted", hash, blockNumber: receipt.blockNumber, ...minted };
  } catch (e) {
    return { status: "details-unavailable", hash, reason: e instanceof Error ? e.message : String(e) };
  }
}
