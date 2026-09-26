import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as unknown[], fail: false, running: 0, peak: 0, calls: [] as bigint[] }));

vi.mock("@/lib/ponder-server", async () => {
  const schema = await import("../../indexer/ponder.schema");
  const chain = { from: () => chain, where: async () => { if (state.fail) throw new Error("fetch failed"); return state.rows; } };
  return { schema, ponderServer: () => ({ db: { select: () => chain } }) };
});
vi.mock("@/lib/market-price", () => ({
  marketPriceForCard: vi.fn(async (card: { id: bigint }) => {
    state.calls.push(card.id);
    state.running += 1;
    state.peak = Math.max(state.peak, state.running);
    await new Promise((r) => setTimeout(r, 5));
    state.running -= 1;
    if (card.id === 3n) throw new Error("scryfall down");
    return { usd: `${card.id}.00`, source: { finish: "nonfoil", lang: "en", printingId: "s", englishFallback: false }, conditionMultiplier: 1, adjustedUsd: `${card.id}` };
  }),
}));

import { GET, MAX_IDS } from "@/app/api/cards/prices/route";

const call = (ids: string) => GET(new Request(`http://x/api/cards/prices?ids=${ids}`));
const card = (id: number) => ({ id: BigInt(id), scryfallId: `s${id}`, condition: "NM" });

describe("GET /api/cards/prices", () => {
  beforeEach(() => {
    state.rows = Array.from({ length: 12 }, (_, i) => card(i + 1));
    state.fail = false;
    state.peak = 0;
    state.calls = [];
  });

  it("returns a quote or null per requested id, four at a time, with a shared-cache header", async () => {
    state.rows = [card(1), card(2), card(3)];
    const res = await call("1,2,3,99,2");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["1", "2", "3", "99"]);
    expect(body["1"].usd).toBe("1.00");
    expect(body["3"]).toBeNull(); // the lookup failed
    expect(body["99"]).toBeNull(); // unknown card
    state.rows = Array.from({ length: 12 }, (_, i) => card(i + 1));
    await call(Array.from({ length: 12 }, (_, i) => i + 1).join(","));
    expect(state.peak).toBe(4);
  });

  it("validates ids and caps the batch", async () => {
    expect((await call("")).status).toBe(200);
    expect(await (await call("")).json()).toEqual({});
    expect((await call("1,x")).status).toBe(400);
    expect((await call("-1")).status).toBe(400);
    expect((await call(Array.from({ length: MAX_IDS + 1 }, (_, i) => i).join(","))).status).toBe(400);
  });

  it("answers 503 when the indexer is down", async () => {
    state.fail = true;
    const res = await call("1");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("UNAVAILABLE");
  });
});
