import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MB_QUERIES, MultibaasError } from "@kura/shared";
import { GET } from "@/app/api/analytics/multibaas/route";
import { deployments } from "@/lib/deployments";
import { MAX_SYNC_LAG_BLOCKS, MULTIBAAS_BUDGET_MS, loadMultibaasFigures, multibaasConfig, resetMultibaasMemo } from "@/lib/multibaas/server";

const KEY = "test-key-SECRET";
const now = Math.floor(Date.now() / 1000);
const iso = (t: number) => new Date(t * 1000).toISOString();
const HEAD = deployments().deployBlock + 100_000;
type Status = { isProcessingPastLogs: boolean; latestBlockNumber: number; startBlockNumber: number };
const linked = (): Status => ({ isProcessingPastLogs: false, latestBlockNumber: HEAD, startBlockNumber: HEAD - 10_000 });
const mb = {
  head: HEAD,
  chainID: 11155111,
  status: null as null | "unaliased" | Status,
  rows: {} as Record<string, unknown[]>,
  fail: null as null | string,
  calls: [] as { url: string; auth: string | undefined }[],
};
const reply = (status: number, result?: unknown) =>
  new Response(JSON.stringify({ status, message: status === 200 ? "success" : "nope", ...(result === undefined ? {} : { result }) }), { status });

async function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  mb.calls.push({ url, auth: (init.headers as Record<string, string>).authorization });
  if (mb.fail === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const u = new URL(url);
  const path = u.pathname.replace(/^\/api\/v0/, "");
  if (mb.fail && path.includes(mb.fail)) return reply(500);
  if (path === "/chains/ethereum/status") return reply(200, { blockNumber: mb.head, chainID: mb.chainID });
  // live: 400 "invalid address" without the alias, 404 "Event monitor not found" when aliased but not linked
  if (path.endsWith("/status")) return mb.status === "unaliased" ? reply(400) : mb.status ? reply(200, mb.status) : reply(404);
  const m = /^\/queries\/([^/]+)\/results$/.exec(path);
  if (m) {
    const rows = mb.rows[decodeURIComponent(m[1]!)];
    if (!rows) return reply(404);
    const o = Number(u.searchParams.get("offset") ?? 0), l = Number(u.searchParams.get("limit") ?? 10);
    if (l > 50) return reply(400); // live: the plan's event_query_max_results
    return reply(200, { rows: rows.slice(o, o + l) });
  }
  return reply(404);
}

const mintRow = { at: iso(now - 7200), block: HEAD - 600, tx: "0x2", card: "1" };
function arrange() {
  mb.head = HEAD;
  mb.chainID = 11155111;
  mb.status = linked();
  mb.fail = null;
  mb.calls = [];
  mb.rows = {
    [MB_QUERIES.settles]: [{ at: iso(now - 3600), block: HEAD - 300, tx: "0x1", card: "1", raised: "5136000000", fee: "128400000", graduated: true }],
    [MB_QUERIES.redeems]: [],
    [MB_QUERIES.mints]: [mintRow],
    [MB_QUERIES.fees]: [{ at: iso(now - 3600), block: HEAD - 300, tx: "0x1", card: "1", kind: "0", amount: "128400000" }],
  };
}

const call = (range = "24h") => GET(new Request(`http://x/api/analytics/multibaas?range=${range}`));

describe("GET /api/analytics/multibaas", () => {
  beforeEach(() => {
    process.env.MULTIBAAS_URL = "https://mb.test";
    process.env.MULTIBAAS_API_KEY = KEY;
    resetMultibaasMemo();
    arrange();
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.MULTIBAAS_URL;
    delete process.env.MULTIBAAS_API_KEY;
  });

  it("answers the 24h figures as base-unit strings, the key sent only to MultiBaas", async () => {
    const res = await call("24h");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ source: "multibaas", range: "24h", raised: "5136000000", raisedAuctions: 1, fees: "128400000", mintedInRange: 1, totalMints: 1 });
    expect(body.volume).toHaveLength(24);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(mb.calls.length).toBeGreaterThan(0);
    for (const c of mb.calls) {
      expect(c.url.startsWith("https://mb.test/api/v0/")).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
    }
    // The all-time totals would sum only what MultiBaas still retains (72 h): never read.
    expect(mb.calls.some((c) => c.url.includes(MB_QUERIES.raisedTotal) || c.url.includes(MB_QUERIES.feesTotal))).toBe(false);
  });

  it("answers 503 RANGE_UNSUPPORTED for 7d and all without calling MultiBaas (it keeps 72 h of events)", async () => {
    for (const range of ["7d", "all", "bogus"]) {
      const res = await call(range);
      expect(res.status, range).toBe(503);
      expect((await res.json()).error.code, range).toBe("RANGE_UNSUPPORTED");
    }
    expect(mb.calls).toEqual([]);
  });

  it("answers 503 UNCONFIGURED without the URL or the key, and calls nothing", async () => {
    delete process.env.MULTIBAAS_API_KEY;
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("UNCONFIGURED");
    expect(mb.calls).toEqual([]);
    expect(multibaasConfig({ MULTIBAAS_URL: "http://mb.test", MULTIBAAS_API_KEY: "k" })).toBeNull();
    expect(multibaasConfig({ MULTIBAAS_URL: "not a url", MULTIBAAS_API_KEY: "k" })).toBeNull();
    expect(multibaasConfig({ MULTIBAAS_URL: " https://mb.test/ ", MULTIBAAS_API_KEY: " k " })).toEqual({ url: "https://mb.test", apiKey: "k" });
  });

  it("answers 503 UNAVAILABLE when MultiBaas errors, times out, is unlinked, still syncing, behind, too new, or lacks a query", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: [string, () => void][] = [
      ["a failing query", () => { mb.fail = `/queries/${MB_QUERIES.settles}`; }],
      ["a timeout", () => { mb.fail = "timeout"; }],
      ["an unlinked vault", () => { mb.status = null; }],
      ["an unaliased vault", () => { mb.status = "unaliased"; }],
      ["another chain", () => { mb.chainID = 1; }],
      ["a sync in progress", () => { mb.status = { ...linked(), isProcessingPastLogs: true }; }],
      ["an index behind the chain", () => { mb.head = HEAD + MAX_SYNC_LAG_BLOCKS + 1; }],
      ["a link newer than the window", () => { mb.status = { ...linked(), startBlockNumber: HEAD - 95 }; }],
      ["a status without its start block", () => { mb.status = { isProcessingPastLogs: false, latestBlockNumber: HEAD } as Status; }],
      ["a missing saved query", () => { delete mb.rows[MB_QUERIES.mints]; }],
    ];
    for (const [name, change] of cases) {
      resetMultibaasMemo();
      arrange();
      change();
      const res = await call();
      expect(res.status, name).toBe(503);
      expect((await res.json()).error.code, name).toBe("UNAVAILABLE");
    }
    expect(warn).toHaveBeenCalledTimes(cases.length);
    for (const [msg] of warn.mock.calls) expect(String(msg)).not.toContain(KEY);
  });

  it("serves a vault younger than the window once MultiBaas indexed it from its deployment", async () => {
    mb.head = deployments().deployBlock + 500;
    mb.status = { isProcessingPastLogs: false, latestBlockNumber: mb.head, startBlockNumber: deployments().deployBlock };
    expect((await call()).status).toBe(200);
  });

  it("refuses rows whose amounts are not base-unit integers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mb.rows[MB_QUERIES.settles] = [{ at: iso(now - 3600), block: 900, tx: "0x1", card: "1", raised: "5136.000000", fee: "0", graduated: true }];
    expect((await call()).status).toBe(503);
    resetMultibaasMemo();
    mb.rows[MB_QUERIES.settles] = [{ at: iso(now - 3600), block: 900, tx: "0x1", card: "1", raised: 1e21, fee: "0", graduated: true }];
    expect((await call()).status).toBe(503);
  });

  it("memoises a good answer for 15 s, never a failure", async () => {
    await call();
    const n = mb.calls.length;
    await call();
    expect(mb.calls.length).toBe(n);

    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetMultibaasMemo();
    mb.fail = "timeout";
    expect((await call()).status).toBe(503);
    mb.fail = null;
    expect((await call()).status).toBe(200);
  });

  it("reads a query past MB_PAGE rows page by page, 50 at a time", async () => {
    mb.rows[MB_QUERIES.mints] = Array.from({ length: 120 }, (_, i) => ({ ...mintRow, at: iso(now - 7200 - i), tx: `0x${i}`, card: String(i + 1) }));
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).mintedInRange).toBe(120);
    const pages = mb.calls.filter((c) => c.url.includes(`/queries/${MB_QUERIES.mints}/results`)).map((c) => new URL(c.url).search);
    expect(pages).toEqual(["?offset=0&limit=50", "?offset=50&limit=50", "?offset=100&limit=50"]);
  });
});

describe("loadMultibaasFigures's overall budget", () => {
  const cfg = { url: "https://mb.test", apiKey: KEY };
  const many = () => Array.from({ length: 1000 }, (_, i) => ({ ...mintRow, at: iso(now - i), tx: `0x${i}`, card: String(i) }));
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  beforeEach(arrange);

  it("is under the dashboard's 6 s client cap", () => {
    expect(MULTIBAAS_BUDGET_MS).toBeLessThan(6_000);
  });

  it("gives up at the budget even when a request never settles, and aborts every request", async () => {
    const signals: AbortSignal[] = [];
    const hang = (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return new Promise<Response>(() => {}); // ignores its signal: only the budget can end the load
    };
    const t0 = Date.now();
    const err = await loadMultibaasFigures(cfg, "24h", now, hang, 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultibaasError);
    expect((err as Error).message).toMatch(/took over 50 ms/);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(signals).toHaveLength(6);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("stops paging a large query once the budget is spent", async () => {
    mb.rows[MB_QUERIES.mints] = many();
    const slow = async (url: string, init: RequestInit) => {
      await settle(20);
      init.signal?.throwIfAborted();
      return fakeFetch(url, init);
    };
    await expect(loadMultibaasFigures(cfg, "24h", now, slow, 70)).rejects.toBeInstanceOf(MultibaasError);
    const n = mb.calls.length;
    await settle(100);
    expect(mb.calls.length).toBe(n); // no page is requested after the budget ran out
    expect(mb.calls.filter((c) => c.url.includes(MB_QUERIES.mints)).length).toBeLessThan(20);
  });

  it("aborts the other queries' paging as soon as one query fails", async () => {
    mb.rows[MB_QUERIES.mints] = many();
    delete mb.rows[MB_QUERIES.redeems];
    const slow = async (url: string, init: RequestInit) => {
      if (!url.includes(MB_QUERIES.redeems)) await settle(10);
      init.signal?.throwIfAborted();
      return fakeFetch(url, init);
    };
    await expect(loadMultibaasFigures(cfg, "24h", now, slow, 5_000)).rejects.toThrow(/kura_redeems is missing/);
    const n = mb.calls.length;
    await settle(60);
    expect(mb.calls.length).toBe(n);
  });
});
