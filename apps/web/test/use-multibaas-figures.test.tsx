// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MULTIBAAS_CLIENT_TIMEOUT_MS,
  MULTIBAAS_REFETCH_MS,
  fetchMultibaasFigures,
  fetchMultibaasRecent,
  useMultibaasFigures,
  useMultibaasRecent,
} from "@/hooks/use-multibaas-figures";

const wire = (range: string) => ({
  source: "multibaas", range, window: { from: 0, to: 10, unit: range === "24h" ? "hour" : "day" }, raised: "5136000000", raisedAuctions: 1,
  fees: "153400000", mintedInRange: 1, totalMints: 2, volume: [{ date: "2026-09-26T14", volumeUsdc: "1000000000" }],
});
const recentWire = {
  source: "multibaas", view: "recent", coverage: { startBlock: 11_785_122, since: 1_790_000_000, fromDeploy: false }, total: 1,
  events: [{ kind: "mint", card: "9", at: 1_790_000_100, block: 11_785_130, tx: "0xab", amount: null, graduated: null, feeKind: null }],
};
const answer = (fn: (url: string, init?: RequestInit) => Promise<Response>) => vi.stubGlobal("fetch", vi.fn(fn));
const route = (url: string) => {
  const p = new URL(url, "http://x").searchParams;
  return p.get("view") === "recent" ? new Response(JSON.stringify(recentWire), { status: 200 }) : new Response(JSON.stringify(wire(p.get("range")!)), { status: 200 });
};
const urls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => String(u));
function wrapper(client = new QueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchMultibaasFigures / fetchMultibaasRecent", () => {
  it("parses the route's answers", async () => {
    answer(async (url) => route(url));
    expect(await fetchMultibaasFigures("24h")).toMatchObject({ range: "24h", raised: 5_136_000_000n });
    expect(await fetchMultibaasRecent()).toMatchObject({ total: 1, events: [{ kind: "mint", card: 9n }] });
  });

  it("answers null, never throws, when the route is unconfigured, down, garbled or unreachable", async () => {
    for (const f of [() => fetchMultibaasFigures("24h"), () => fetchMultibaasRecent()]) {
      answer(async () => new Response('{"error":{"code":"UNCONFIGURED"}}', { status: 503 }));
      expect(await f()).toBeNull();
      answer(async () => new Response("<html>", { status: 200 }));
      expect(await f()).toBeNull();
      answer(async () => { throw new TypeError("Failed to fetch"); });
      expect(await f()).toBeNull();
    }
  });

  it("gives up after MULTIBAAS_CLIENT_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    answer((_url, init) => new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const p = fetchMultibaasFigures("24h");
    const q = fetchMultibaasRecent();
    await vi.advanceTimersByTimeAsync(MULTIBAAS_CLIENT_TIMEOUT_MS);
    expect(await p).toBeNull();
    expect(await q).toBeNull();
  });
});

describe("useMultibaasFigures", () => {
  it("fetches only 24h (MultiBaas serves nothing longer) and answers no figures for 7d and All at once", async () => {
    answer(async (url) => route(url));
    const { result, rerender } = renderHook(({ range }: { range: "24h" | "7d" | "all" }) => useMultibaasFigures(range), { wrapper: wrapper(), initialProps: { range: "7d" } });
    expect(result.current).toEqual({ figures: null, pending: false });
    await waitFor(() => expect(urls()).toEqual(["/api/analytics/multibaas?range=24h"]));
    rerender({ range: "24h" });
    await waitFor(() => expect(result.current.figures?.range).toBe("24h"));
    expect(result.current.pending).toBe(false);
    rerender({ range: "all" });
    expect(result.current).toEqual({ figures: null, pending: false });
    expect(urls()).toHaveLength(1);
  });

  it("is pending on 24h until the first answer, then settles to no figures when MultiBaas is unavailable", async () => {
    answer(async () => new Response('{"error":{"code":"UNAVAILABLE"}}', { status: 503 }));
    const { result } = renderHook(() => useMultibaasFigures("24h"), { wrapper: wrapper() });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.figures).toBeNull();
  });

  it("polls no faster than the server's 10 min snapshot and not on window focus", async () => {
    answer(async (url) => route(url));
    const client = new QueryClient();
    renderHook(() => { useMultibaasFigures("24h"); useMultibaasRecent(); }, { wrapper: wrapper(client) });
    await waitFor(() => expect(urls()).toHaveLength(2));
    expect(MULTIBAAS_REFETCH_MS).toBeGreaterThanOrEqual(600_000);
    for (const key of [["multibaas-figures", "24h"], ["multibaas-recent"]]) {
      const q = client.getQueryCache().find({ queryKey: key })!;
      const o = q.options as { refetchInterval?: unknown; refetchOnWindowFocus?: unknown; staleTime?: unknown; retry?: unknown };
      expect(o.refetchInterval).toBe(MULTIBAAS_REFETCH_MS);
      expect(o.staleTime).toBe(MULTIBAAS_REFETCH_MS);
      expect(o.refetchOnWindowFocus).toBe(false);
      expect(o.retry).toBe(false);
    }
  });
});

describe("useMultibaasRecent", () => {
  it("answers the recent events, or null while MultiBaas is unavailable", async () => {
    answer(async (url) => route(url));
    const ok = renderHook(() => useMultibaasRecent(), { wrapper: wrapper() });
    expect(ok.result.current).toBeNull();
    await waitFor(() => expect(ok.result.current?.total).toBe(1));
    answer(async () => new Response('{"error":{"code":"UNAVAILABLE"}}', { status: 503 }));
    const down = renderHook(() => useMultibaasRecent(), { wrapper: wrapper() });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(down.result.current).toBeNull();
  });
});
