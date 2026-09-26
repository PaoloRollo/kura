import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cards: [] as unknown[],
  printings: {} as Record<string, unknown>,
  quotes: {} as Record<string, unknown>,
  inserts: [] as { values: Record<string, unknown>; set: Record<string, unknown> }[],
}));

vi.mock("@/lib/ponder-server", async () => {
  const schema = await import("../../indexer/ponder.schema");
  const chain = { from: () => chain, where: async () => state.cards };
  return { schema, ponderServer: () => ({ db: { select: () => chain } }) };
});
vi.mock("@/lib/scryfall", () => ({ scryfall: () => ({ getCard: async (id: string) => state.printings[id] ?? null }) }));
vi.mock("@/lib/market-price", () => ({ marketPriceForCard: vi.fn(async (card: { scryfallId: string }) => state.quotes[card.scryfallId] ?? null) }));
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    insert: () => ({ values: (values: Record<string, unknown>) => ({ onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => { state.inserts.push({ values, set }); } }) }),
  }),
}));

import { GET } from "@/app/api/cron/prices/route";

const printing = (id: string, usd: string | null) => ({ id, prices: { usd, usd_foil: "9.00", usd_etched: null, eur: "1.00" } });
const quote = (fallback: string | null) => ({ usd: "1", source: { finish: "nonfoil", lang: "en", printingId: fallback, englishFallback: fallback != null }, conditionMultiplier: 1, adjustedUsd: "1" });

describe("cron prices", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "s3cret";
    state.inserts = [];
  });

  it("rejects calls without the secret", async () => {
    const res = await GET(new Request("http://localhost/api/cron/prices"));
    expect(res.status).toBe(401);
    const bad = await GET(new Request("http://localhost/api/cron/prices", { headers: { authorization: "Bearer nope" } }));
    expect(bad.status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(new Request("http://localhost/api/cron/prices", { headers: { authorization: "Bearer " } }))).status).toBe(401);
  });

  it("snapshots each printing once per day, and the English printing when the quote falls back to it", async () => {
    state.cards = [{ id: 1n, scryfallId: "ja", condition: "NM" }, { id: 2n, scryfallId: "en1", condition: "LP" }, { id: 3n, scryfallId: "en1", condition: "NM" }];
    state.printings = { ja: printing("ja", null), en: printing("en", "12.00"), en1: printing("en1", "3.00") };
    state.quotes = { ja: quote("en"), en1: quote(null) };
    const res = await GET(new Request("http://localhost/api/cron/prices", { headers: { authorization: "Bearer s3cret" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 3, total: 3 });
    const today = new Date().toISOString().slice(0, 10);
    expect(state.inserts.map((i) => i.values.scryfallId)).toEqual(["ja", "en", "en1"]);
    expect(state.inserts[1]!.values).toEqual({ scryfallId: "en", date: today, usd: "12.00", usdFoil: "9.00", usdEtched: null, eur: "1.00" });
  });
});
