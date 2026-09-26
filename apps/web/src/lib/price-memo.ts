import type { PriceQuote } from "@/lib/pricing";

/** Largest card id the price routes accept: the indexer's bigint column tops out at 2^63 - 1. */
export const MAX_CARD_ID = 2n ** 63n - 1n;

/** How long a looked-up quote is reused in this process. */
export const MEMO_TTL_MS = 45_000;
/** Entries past which the memo evicts (expired first, then oldest). */
export const MEMO_MAX = 2000;

const memo = new Map<string, { value: PriceQuote | null; at: number }>();

/** The memoised quote for a card id (`{ value }`, value possibly null for "no price"), or undefined when absent or stale. */
export function memoGet(id: string, now = Date.now()): { value: PriceQuote | null } | undefined {
  const hit = memo.get(id);
  if (!hit) return undefined;
  if (now - hit.at > MEMO_TTL_MS) {
    memo.delete(id);
    return undefined;
  }
  return { value: hit.value };
}

/** Memoise a successful lookup (null included); failures are never stored. */
export function memoSet(id: string, value: PriceQuote | null, now = Date.now()) {
  memo.delete(id);
  memo.set(id, { value, at: now });
  if (memo.size <= MEMO_MAX) return;
  for (const [k, v] of memo) if (now - v.at > MEMO_TTL_MS) memo.delete(k);
  // Map iteration is insertion order, so the first keys are the oldest.
  for (const k of memo.keys()) {
    if (memo.size <= MEMO_MAX) break;
    memo.delete(k);
  }
}

export const memoSize = () => memo.size;
export const resetPriceMemo = () => memo.clear();
