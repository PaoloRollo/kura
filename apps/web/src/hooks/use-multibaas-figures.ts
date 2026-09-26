"use client";

import { useQuery } from "@tanstack/react-query";
import type { AnalyticsRange } from "@/lib/analytics-view";
import { fromWire, type MultibaasFigures } from "@/lib/multibaas/figures";
import { recentFromWire, type MultibaasRecent } from "@/lib/multibaas/recent";

/** How long the dashboard waits for MultiBaas before it shows the indexer's figures (or hides the recent panel). */
export const MULTIBAAS_CLIENT_TIMEOUT_MS = 6_000;
/**
 * How often the dashboard asks again: the server keeps each MultiBaas snapshot for 20 min (FIGURES_TTL_MS, for the
 * plan's 30,000 calls a month), so polling faster would only re-read the same answer.
 */
export const MULTIBAAS_REFETCH_MS = 20 * 60_000;

/** GET `path` and parse it, or null (unconfigured, unavailable, garbled, slow, unreachable). Never throws. */
async function getJson<T>(path: string, parse: (json: unknown) => T | null, signal?: AbortSignal): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), MULTIBAAS_CLIENT_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(path, { signal: ctl.signal });
    return res.ok ? parse(await res.json()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** /api/analytics/multibaas for one range: the figures, or null. Never throws. */
export const fetchMultibaasFigures = (range: AnalyticsRange, signal?: AbortSignal): Promise<MultibaasFigures | null> =>
  getJson(`/api/analytics/multibaas?range=${range}`, fromWire, signal);

/** /api/analytics/multibaas?view=recent: the newest vault events MultiBaas holds, or null. Never throws. */
export const fetchMultibaasRecent = (signal?: AbortSignal): Promise<MultibaasRecent | null> =>
  getJson("/api/analytics/multibaas?view=recent", recentFromWire, signal);

const poll = { staleTime: MULTIBAAS_REFETCH_MS, refetchInterval: MULTIBAAS_REFETCH_MS, refetchOnWindowFocus: false, retry: false } as const;

/**
 * The dashboard's MultiBaas figures for `range`. MultiBaas serves only 24h (it keeps 72 h of events), so only 24h is
 * fetched, up front whatever the range, so switching to 24h never waits; 7d and All answer no figures at once.
 * `pending` is true only while the 24h range is selected and its first answer is out (at most
 * MULTIBAAS_CLIENT_TIMEOUT_MS).
 */
export function useMultibaasFigures(range: AnalyticsRange): { figures: MultibaasFigures | null; pending: boolean; available24h: boolean } {
  const q = useQuery({ queryKey: ["multibaas-figures", "24h"], queryFn: ({ signal }) => fetchMultibaasFigures("24h", signal), ...poll });
  // Whether the 24h range really reads MultiBaas right now, whatever range is selected (for the source label).
  const available24h = q.data != null;
  if (range !== "24h") return { figures: null, pending: false, available24h };
  return { figures: q.data ?? null, pending: q.isPending, available24h };
}

/** The recent-events panel's data: null while loading or when MultiBaas is unavailable (the panel is then hidden). */
export function useMultibaasRecent(): MultibaasRecent | null {
  const q = useQuery({ queryKey: ["multibaas-recent"], queryFn: ({ signal }) => fetchMultibaasRecent(signal), ...poll });
  return q.data ?? null;
}
