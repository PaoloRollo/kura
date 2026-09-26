// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({ ready: null as null | { id: string; expiresAt: string }, calls: 0 }));
vi.mock("@/hooks/use-kura-user", () => ({
  useKuraUser: () => ({ identityToken: "tok" }),
  apiFetch: vi.fn(async () => {
    state.calls += 1;
    return new Response(JSON.stringify({ ready: state.ready }));
  }),
}));
vi.mock("@/hooks/use-now", () => ({ useNow: () => 1_000 }));

import { useCollect } from "@/components/collect-at-counter";

function mount() {
  const client = new QueryClient();
  return renderHook(() => useCollect(1n), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}

describe("useCollect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.ready = null;
    state.calls = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("reads the ticket once and stays idle without one", async () => {
    mount();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(state.calls).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(state.calls).toBe(1);
  });

  it("polls every 5 s while a check is in progress or a ticket waits", async () => {
    const h = mount();
    await act(() => vi.advanceTimersByTimeAsync(100));
    act(() => h.result.current.setChecking(true));
    await act(() => vi.advanceTimersByTimeAsync(10_100));
    expect(state.calls).toBe(3);
    act(() => h.result.current.setChecking(false));
    state.ready = { id: "t1", expiresAt: "999999" };
    await act(() => vi.advanceTimersByTimeAsync(0));
    const before = state.calls;
    // Checking off, but the ticket read by the last poll keeps it polling.
    act(() => h.result.current.setChecking(true));
    await act(() => vi.advanceTimersByTimeAsync(5_100));
    act(() => h.result.current.setChecking(false));
    await act(() => vi.advanceTimersByTimeAsync(10_100));
    expect(state.calls).toBeGreaterThanOrEqual(before + 3);
  });
});
