import { describe, expect, it, vi } from "vitest";
import { CARD_VAULT_EVENTS, EVENT_QUERIES, MB, MB_PAGE, MB_QUERIES, MultibaasError, mbQueryRows, mbRequest } from "../src/multibaas";

// MultiBaas's Label/Alias pattern and its EventQueryLabel pattern (openapi.yaml, components.schemas).
const LABEL = /^(?:[a-z1-9_-][a-z0-9_-]*|0(?:[a-wyz0-9_-][a-z0-9_-]*)?)$/;
const QUERY_LABEL = /^[^<>?&"'`/\\]*$/;
const cfg = { url: "https://mb.test/", apiKey: "k-SECRET-123" };
const ok = (result: unknown) => new Response(JSON.stringify({ status: 200, message: "success", result }), { status: 200 });

describe("MultiBaas definitions", () => {
  it("names CardVault events by their canonical signatures", () => {
    expect(CARD_VAULT_EVENTS).toEqual({
      CardMinted: "CardMinted(uint256,address,string,string,string,string)",
      AuctionSettled: "AuctionSettled(uint256,address,uint256,uint256,uint256,bool)",
      CardRedeemed: "CardRedeemed(uint256,address,address,uint256,uint256,uint256)",
      FeeAccrued: "FeeAccrued(uint256,uint8,uint256)",
    });
  });

  it("uses labels MultiBaas accepts", () => {
    for (const l of [MB.contractLabel, MB.addressAlias, MB.webhookLabel]) expect(l).toMatch(LABEL);
    for (const l of Object.values(MB_QUERIES)) expect(l).toMatch(QUERY_LABEL);
    expect(new Set(Object.values(MB_QUERIES)).size).toBe(6);
  });

  it("aggregates with exactly one plain field, the groupBy (MultiBaas's rule)", () => {
    for (const q of [EVENT_QUERIES.raisedTotal, EVENT_QUERIES.feesTotal]) {
      const plain = q.events.flatMap((e) => e.select.filter((f) => !f.aggregator));
      expect(plain.map((f) => f.alias)).toEqual([q.groupBy]);
      expect(q.events.flatMap((e) => e.select.filter((f) => f.aggregator)).every((f) => f.aggregator === "add")).toBe(true);
    }
  });

  it("selects USDC amounts only, never 18-decimal shard units", () => {
    const inputs = Object.values(EVENT_QUERIES).flatMap((q) => q.events.flatMap((e) => e.select.filter((f) => f.type === "input").map((f) => f.name)));
    expect(new Set(inputs)).toEqual(new Set(["id", "raisedUsdc", "feeUsdc", "graduated", "payoutUsdc", "kind", "amountUsdc"]));
  });

  it("gives every list query a timestamp and a stable order", () => {
    for (const k of ["settles", "redeems", "mints", "fees"] as const) {
      const q = EVENT_QUERIES[k];
      expect(q.events[0]!.select.map((f) => f.alias).slice(0, 3)).toEqual(["at", "block", "tx"]);
      expect(q.orderBy).toBe("block");
      expect(q.order).toBe("ASC");
    }
  });
});

describe("mbRequest", () => {
  it("sends the bearer key to /api/v0 and unwraps result", async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => ok({ chainID: 11155111 }));
    await expect(mbRequest(cfg, "GET", "/chains/ethereum/status", { fetch: f })).resolves.toEqual({ chainID: 11155111 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://mb.test/api/v0/chains/ethereum/status");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k-SECRET-123");
    expect(init.body).toBeUndefined();
  });

  it("sends a JSON body", async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => ok(null));
    await mbRequest(cfg, "PUT", "/queries/kura_mints", { body: { events: [] }, fetch: f });
    const init = f.mock.calls[0]![1];
    expect(init.method).toBe("PUT");
    expect(init.body).toBe('{"events":[]}');
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("answers null for a 404 and throws a MultibaasError without the key otherwise", async () => {
    await expect(mbRequest(cfg, "GET", "/contracts/x", { fetch: async () => new Response('{"status":404,"message":"Unknown contract"}', { status: 404 }) })).resolves.toBeNull();
    const err = await mbRequest(cfg, "PUT", "/queries/q", { body: {}, fetch: async () => new Response('{"status":400,"message":"bad query"}', { status: 400 }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultibaasError);
    expect((err as MultibaasError).status).toBe(400);
    expect((err as MultibaasError).message).toBe("PUT /queries/q → 400: bad query");
    expect((err as MultibaasError).message).not.toContain("SECRET");
  });

  it("turns a hung request into a MultibaasError after the timeout", async () => {
    const hang = (_u: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
    const err = await mbRequest(cfg, "GET", "/queries/q/results", { fetch: hang, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultibaasError);
    expect((err as MultibaasError).status).toBeNull();
    expect((err as MultibaasError).message).toMatch(/timed out/);
  });
});

describe("mbRequest bodies", () => {
  it("throws on a success that is not JSON instead of answering null", async () => {
    const err = await mbRequest(cfg, "GET", "/queries/q/results", { fetch: async () => new Response("<html>proxy</html>", { status: 200 }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultibaasError);
    expect((err as MultibaasError).status).toBe(200);
    expect((err as MultibaasError).message).toBe("GET /queries/q/results answered non-JSON");
  });

  it("reports a body that stalls past the timeout as timed out", async () => {
    const stalled = (_u: string, init: RequestInit) => {
      const body = new ReadableStream({ start: (c) => init.signal!.addEventListener("abort", () => c.error(init.signal!.reason)) });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    const err = await mbRequest(cfg, "GET", "/queries/q/results", { fetch: stalled, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultibaasError);
    expect((err as MultibaasError).status).toBeNull();
    expect((err as MultibaasError).message).toBe("GET /queries/q/results timed out");
  });

  it("releases a 404's body", async () => {
    const res = new Response("404 page not found", { status: 404 });
    const cancel = vi.spyOn(res.body!, "cancel");
    await expect(mbRequest(cfg, "GET", "/contracts/x", { fetch: async () => res })).resolves.toBeNull();
    expect(cancel).toHaveBeenCalled();
  });
});

describe("mbQueryRows", () => {
  it("pages through a saved query and refuses to truncate", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ n: i }));
    const f = vi.fn(async (url: string) => {
      const u = new URL(url);
      const o = Number(u.searchParams.get("offset")), l = Number(u.searchParams.get("limit"));
      return ok({ rows: all.slice(o, o + l) });
    });
    await expect(mbQueryRows(cfg, "kura_mints", { fetch: f, pageSize: 2 })).resolves.toEqual(all);
    expect(f).toHaveBeenCalledTimes(3);
    expect(f.mock.calls[0]![0]).toBe("https://mb.test/api/v0/queries/kura_mints/results?offset=0&limit=2");
    await expect(mbQueryRows(cfg, "kura_mints", { fetch: f, pageSize: 2, maxPages: 2 })).rejects.toThrow(/4 rows or more/);
  });

  it("pages by at most 50, the deployment's maximum limit", async () => {
    expect(MB_PAGE).toBeLessThanOrEqual(50);
    const f = vi.fn(async (_url: string) => ok({ rows: [] }));
    await mbQueryRows(cfg, "kura_mints", { fetch: f });
    expect(f.mock.calls[0]![0]).toBe(`https://mb.test/api/v0/queries/kura_mints/results?offset=0&limit=${MB_PAGE}`);
  });

  it("says which saved query is missing", async () => {
    await expect(mbQueryRows(cfg, "kura_mints", { fetch: async () => new Response("404 page not found", { status: 404 }) })).rejects.toThrow(/kura_mints is missing/);
  });
});

describe("Event Query input indices", () => {
  it("gives every input field its position in the event (MultiBaas requires inputIndex)", async () => {
    const { EVENT_QUERIES } = await import("../src/multibaas");
    const { cardVaultAbi } = await import("../src/abi");
    for (const q of Object.values(EVENT_QUERIES)) {
      for (const e of q.events) {
        const name = e.eventName.slice(0, e.eventName.indexOf("("));
        const abiEvent = (cardVaultAbi as unknown as { type: string; name?: string; inputs: { name: string }[] }[]).find((x) => x.type === "event" && x.name === name)!;
        for (const f of e.select.filter((f) => f.type === "input")) {
          expect(f.inputIndex, `${name}.${f.name}`).toBe(abiEvent.inputs.findIndex((p) => p.name === f.name));
        }
      }
    }
  });
});
