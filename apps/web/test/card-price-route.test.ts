import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as unknown[], fail: false, quote: null as unknown }));

vi.mock("@/lib/ponder-server", async () => {
  const schema = await import("../../indexer/ponder.schema");
  const chain = { from: () => chain, where: () => chain, limit: async () => { if (state.fail) throw new Error("fetch failed"); return state.rows; } };
  return { schema, ponderServer: () => ({ db: { select: () => chain } }) };
});
vi.mock("@/lib/market-price", () => ({ marketPriceForCard: vi.fn(async () => state.quote) }));

import { GET } from "@/app/api/cards/[id]/price/route";

const call = (id: string) => GET(new Request(`http://x/api/cards/${id}/price`), { params: Promise.resolve({ id }) });

describe("GET /api/cards/[id]/price", () => {
  beforeEach(() => {
    state.rows = [{ id: 1n, scryfallId: "s", condition: "NM" }];
    state.fail = false;
    state.quote = { usd: "1.00", source: { finish: "nonfoil", lang: "en", printingId: "s", englishFallback: false }, conditionMultiplier: 1, adjustedUsd: "1" };
  });

  it("returns the quote with a shared-cache header", async () => {
    const res = await call("1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    expect((await res.json()).usd).toBe("1.00");
  });

  it("answers 503, not 500, when the indexer is down", async () => {
    state.fail = true;
    const res = await call("1");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("UNAVAILABLE");
  });

  it("rejects bad ids and unknown cards", async () => {
    expect((await call("x")).status).toBe(400);
    state.rows = [];
    expect((await call("2")).status).toBe(404);
  });
});
