import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cards: [] as unknown[],
  description: null as string | null,
  quote: null as unknown,
  rows: [] as unknown[],
  queried: [] as unknown[],
}));

vi.mock("@/lib/ponder-server", async () => {
  const schema = await import("../../indexer/ponder.schema");
  const chain = { from: () => chain, where: () => chain, limit: async () => state.cards };
  return { schema, ponderServer: () => ({ db: { select: () => chain } }) };
});
vi.mock("@/lib/market-price", () => ({ mintDescription: async () => state.description, marketPriceForCard: async () => state.quote }));
vi.mock("@/lib/scryfall", () => ({
  ScryfallUnavailableError: class extends Error {},
  // The route prices through marketPriceForCard (mocked) alone: any direct Scryfall lookup fails the test.
  scryfall: () => ({ getCard: async () => { throw new Error("unexpected getCard"); } }),
}));
vi.mock("drizzle-orm", async (orig) => {
  const real = await orig<typeof import("drizzle-orm")>();
  return { ...real, eq: (_c: unknown, v: unknown) => { state.queried.push(v); return real.eq(_c as never, v); } };
});
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ orderBy: async () => state.rows }) }) }) }),
}));

import { GET } from "@/app/api/cards/[id]/market/route";

const call = (id: string) => GET(new Request(`http://x/api/cards/${id}/market`), { params: Promise.resolve({ id }) });
const q = (fallback: string | null) => ({ usd: "1", source: { finish: "foil", lang: "en", printingId: fallback ?? "own", englishFallback: fallback != null }, conditionMultiplier: 0.85, adjustedUsd: "0.85" });

describe("GET /api/cards/[id]/market", () => {
  beforeEach(() => {
    state.cards = [{ id: 1n, scryfallId: "own", condition: "LP" }];
    state.description = "Black Lotus, Limited Edition Alpha, foil";
    state.quote = q(null);
    state.queried = [];
    state.rows = [
      { scryfallId: "own", date: "2026-09-24", usd: "10.00", usdFoil: "100.00", usdEtched: null, eur: null },
      { scryfallId: "own", date: "2026-09-25", usd: "10.00", usdFoil: null, usdEtched: null, eur: null },
    ];
  });

  it("prices each snapshot at the card's finish and condition", async () => {
    const res = await call("1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { date: "2026-09-24", usd: "100.00", adjustedUsd: "85" },
      { date: "2026-09-25", usd: null, adjustedUsd: null },
    ]);
    expect(state.queried).toContain("own");
  });

  it("reads the English printing's rows when the card is priced at it", async () => {
    state.quote = q("en-print");
    await call("1");
    expect(state.queried).toContain("en-print");
  });

  it("takes the finish from the quote, not a second lookup", async () => {
    state.description = null;
    state.quote = { ...q(null), source: { ...q(null).source, finish: "nonfoil" } };
    expect(await (await call("1")).json()).toEqual([
      { date: "2026-09-24", usd: "10.00", adjustedUsd: "8.5" },
      { date: "2026-09-25", usd: "10.00", adjustedUsd: "8.5" },
    ]);
  });

  it("404s when the card's printing is unknown", async () => {
    state.quote = null;
    expect((await call("1")).status).toBe(404);
  });

  it("rejects bad ids and unknown cards", async () => {
    expect((await call("x")).status).toBe(400);
    state.cards = [];
    expect((await call("2")).status).toBe(404);
  });
});
