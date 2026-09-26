import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MB_QUERIES, MultibaasError } from "@kura/shared";
import { GET } from "@/app/api/analytics/multibaas/route";
import { deployments } from "@/lib/deployments";
import {
  FAILURE_TTL_MS,
  FIGURES_TTL_MS,
  MULTIBAAS_BUDGET_MS,
  invalidateMultibaasFigures,
  loadMultibaasFigures,
  multibaasConfig,
} from "@/lib/multibaas/server";

const KEY = "test-key-SECRET";
const now = Math.floor(Date.now() / 1000);
const iso = (t: number) => new Date(t * 1000).toISOString();
const HEAD = deployments().deployBlock + 100_000;
type Status = { isProcessingPastLogs: boolean; latestBlockNumber: number; startBlockNumber: number };
// live: latestBlockNumber stays at the link-time block while the contract emits nothing; the loader ignores it
const linked = (): Status => ({ isProcessingPastLogs: false, latestBlockNumber: HEAD - 10_000, startBlockNumber: HEAD - 10_000 });
const mb = {
  head: HEAD,
  chainID: 11155111,
  status: null as null | "unaliased" | Status,
  rows: {} as Record<string, unknown[]>,
  fail: null as null | string,
  calls: [] as { url: string; auth: string | undefined }[],
  /** ms the fake clock moves on each request, so a load resolves later than it starts */
  tick: 0,
};
let clock = 0;
const reply = (status: number, result?: unknown) =>
  new Response(JSON.stringify({ status, message: status === 200 ? "success" : "nope", ...(result === undefined ? {} : { result }) }), { status });

async function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  mb.calls.push({ url, auth: (init.headers as Record<string, string>).authorization });
  clock += mb.tick;
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
  mb.tick = 0;
  mb.rows = {
    [MB_QUERIES.settles]: [{ at: iso(now - 3600), block: HEAD - 300, tx: "0x1", card: "1", raised: "5136000000", fee: "128400000", graduated: true }],
    [MB_QUERIES.redeems]: [],
    [MB_QUERIES.mints]: [mintRow],
    [MB_QUERIES.fees]: [{ at: iso(now - 3600), block: HEAD - 300, tx: "0x1", card: "1", kind: "0", amount: "128400000" }],
  };
}

const call = (range = "24h") => GET(new Request(`http://x/api/analytics/multibaas?range=${range}`));
const recent = () => GET(new Request("http://x/api/analytics/multibaas?view=recent"));

describe("GET /api/analytics/multibaas", () => {
  beforeEach(() => {
    process.env.MULTIBAAS_URL = "https://mb.test";
    process.env.MULTIBAAS_API_KEY = KEY;
    invalidateMultibaasFigures();
    arrange();
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
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
    expect(mb.calls).toHaveLength(6); // chain status, indexing status, then the four list queries
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

  it("answers 503 UNAVAILABLE when MultiBaas errors, times out, is unlinked, still syncing, too new, or lacks a query", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // [name, change, calls spent, the cause logged]: a guard failure never reaches the four queries
    const cases: [string, () => void, number, RegExp][] = [
      ["a failing query", () => { mb.fail = `/queries/${MB_QUERIES.settles}`; }, 6, /500/],
      ["a timeout", () => { mb.fail = "timeout"; }, 2, /./],
      ["a failing chain status", () => { mb.fail = "/chains/ethereum/status"; }, 2, /500/],
      ["an unlinked vault", () => { mb.status = null; }, 2, /not linked/],
      ["an unaliased vault", () => { mb.status = "unaliased"; }, 2, /not linked/],
      ["another chain", () => { mb.chainID = 1; }, 2, /on chain 1/],
      ["a sync in progress", () => { mb.status = { ...linked(), isProcessingPastLogs: true }; }, 2, /still syncing/],
      // the snapshot still loads (6 calls): the recent-events panel shows it; only the 24h figures refuse it
      ["a link newer than the window", () => { mb.status = { ...linked(), startBlockNumber: HEAD - 95 }; }, 6, /not the whole 24h window/],
      ["a status without its start block", () => { mb.status = { isProcessingPastLogs: false, latestBlockNumber: HEAD } as Status; }, 2, /startBlockNumber/],
      ["a missing saved query", () => { delete mb.rows[MB_QUERIES.mints]; }, 6, /kura_mints is missing/],
    ];
    for (const [name, change, calls, cause] of cases) {
      invalidateMultibaasFigures();
      arrange();
      change();
      warn.mockClear();
      const res = await call();
      expect(res.status, name).toBe(503);
      expect((await res.json()).error.code, name).toBe("UNAVAILABLE");
      expect(mb.calls, name).toHaveLength(calls);
      expect(warn, name).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0]), name).toMatch(cause);
      expect(String(warn.mock.calls[0]![0]), name).not.toContain(KEY);
    }
  });

  it("serves a quiet vault whose indexing status still shows the link-time block", async () => {
    mb.head = HEAD + 50_000;
    mb.status = { isProcessingPastLogs: false, latestBlockNumber: HEAD - 10_000, startBlockNumber: HEAD - 10_000 };
    expect((await call()).status).toBe(200);
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
    invalidateMultibaasFigures();
    mb.rows[MB_QUERIES.settles] = [{ at: iso(now - 3600), block: 900, tx: "0x1", card: "1", raised: 1e21, fee: "0", graduated: true }];
    expect((await call()).status).toBe(503);
  });

  it("reuses a good answer for FIGURES_TTL_MS (10 min), counted from when its load resolved", async () => {
    expect(FIGURES_TTL_MS).toBe(600_000);
    mb.tick = 30_000; // six requests: the load resolves 3 min after it started
    const t0 = clock;
    expect((await call()).status).toBe(200);
    expect(clock).toBe(t0 + 180_000);
    mb.tick = 0;
    clock = t0 + FIGURES_TTL_MS + 60_000; // past the TTL from the start, inside it from the resolve
    expect((await call()).status).toBe(200);
    expect(mb.calls).toHaveLength(6);
    clock = t0 + 180_000 + FIGURES_TTL_MS;
    expect((await call()).status).toBe(200);
    expect(mb.calls).toHaveLength(12);
  });

  it("shares one load between concurrent requests", async () => {
    const answers = await Promise.all([call(), call(), call()]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(mb.calls).toHaveLength(6);
  });

  it("reuses a failure for FAILURE_TTL_MS (10 min, as long as an answer), still answering 503 and logging its cause", async () => {
    expect(FAILURE_TTL_MS).toBe(600_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mb.status = null;
    expect((await call()).status).toBe(503);
    expect(mb.calls).toHaveLength(2);
    mb.status = linked(); // fixed, but the failure is still reused
    clock += FAILURE_TTL_MS - 1;
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("UNAVAILABLE");
    expect(mb.calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [msg] of warn.mock.calls) expect(String(msg)).toMatch(/not linked/);
    clock += 1;
    expect((await call()).status).toBe(200);
    expect(mb.calls).toHaveLength(8);
  });

  it("invalidateMultibaasFigures drops a good answer and a failure, and never keeps a load it overtook", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await call();
    invalidateMultibaasFigures();
    await call();
    expect(mb.calls).toHaveLength(12);

    invalidateMultibaasFigures();
    mb.calls = [];
    mb.fail = "timeout";
    expect((await call()).status).toBe(503);
    mb.fail = null;
    invalidateMultibaasFigures();
    expect((await call()).status).toBe(200);
    expect(mb.calls).toHaveLength(8);

    // an event arrives while a load is in flight: that load answers its caller but the next request loads afresh
    invalidateMultibaasFigures();
    mb.calls = [];
    const inFlight = call();
    invalidateMultibaasFigures();
    expect((await inFlight).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(mb.calls).toHaveLength(12);
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
    expect(signals).toHaveLength(2); // the queries wait for the two status calls
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

describe("GET /api/analytics/multibaas?view=recent", () => {
  beforeEach(() => {
    process.env.MULTIBAAS_URL = "https://mb.test";
    process.env.MULTIBAAS_API_KEY = KEY;
    invalidateMultibaasFigures();
    arrange();
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.MULTIBAAS_URL;
    delete process.env.MULTIBAAS_API_KEY;
  });

  it("lists the events MultiBaas holds, newest first, with since when, sharing the figures' load", async () => {
    mb.rows[MB_QUERIES.redeems] = [{ at: iso(now - 60), block: HEAD - 5, tx: "0xAB", card: "2", payout: "900000000", fee: "22500000" }];
    mb.rows[MB_QUERIES.fees].push({ at: iso(now - 60), block: HEAD - 5, tx: "0xab", card: "2", kind: "1", amount: "22500000" });
    expect((await call()).status).toBe(200);
    const res = await recent();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.events.map((e: { kind: string; block: number }) => [e.kind, e.block])).toEqual([
      ["fee", HEAD - 5], ["redeem", HEAD - 5], ["fee", HEAD - 300], ["settle", HEAD - 300], ["mint", HEAD - 600],
    ]);
    expect(body.events[1]).toMatchObject({ card: "2", amount: "900000000", tx: "0xab", graduated: null });
    expect(body.events[0]).toMatchObject({ feeKind: "buyout", amount: "22500000" });
    expect(body.total).toBe(5);
    expect(body.coverage).toEqual({ startBlock: HEAD - 10_000, since: Math.floor(clock / 1000) - 10_000 * 12, fromDeploy: false });
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(mb.calls).toHaveLength(6); // one load for both views
  });

  it("answers while the link is too new for the 24h figures, and when MultiBaas holds nothing yet", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mb.status = { ...linked(), startBlockNumber: HEAD - 95 };
    for (const k of Object.keys(mb.rows)) mb.rows[k] = [];
    expect((await call()).status).toBe(503);
    const res = await recent();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
    expect(body.coverage.startBlock).toBe(HEAD - 95);
    expect(mb.calls).toHaveLength(6);
  });

  it("answers 503 when MultiBaas is unconfigured, unlinked, or answers rows of another shape", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mb.status = null;
    let res = await recent();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("UNAVAILABLE");
    expect(String(warn.mock.calls[0]![0])).toMatch(/recent events are hidden.*not linked/);
    invalidateMultibaasFigures();
    arrange();
    mb.rows[MB_QUERIES.mints] = [{ ...mintRow, tx: 42 }];
    expect((await recent()).status).toBe(503);
    delete process.env.MULTIBAAS_URL;
    res = await recent();
    expect((await res.json()).error.code).toBe("UNCONFIGURED");
  });
});
