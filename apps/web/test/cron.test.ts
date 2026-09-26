import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cards: [] as unknown[],
  printings: {} as Record<string, unknown>,
  quotes: {} as Record<string, unknown>,
  inserts: [] as { values: Record<string, unknown>; set: Record<string, unknown> }[],
  lookups: [] as { id: string; opts: unknown }[],
  ens: false,
  nodes: {} as Record<string, string>,
  balance: 10n ** 17n as bigint | Error,
}));

vi.mock("@/lib/appraise", () => ({
  ENS_WRITE_TIMEOUT_MS: 5_000,
  defaultDeps: {
    ensWritesEnabled: () => state.ens,
    signerBalance: vi.fn(async () => { if (state.balance instanceof Error) throw state.balance; return state.balance; }),
    loadEnsNode: vi.fn(async (id: bigint) => state.nodes[id.toString()] ?? null),
    loadEnsText: vi.fn(async (_node: string, key: string) => (key === "description" ? "a card, foil" : null)),
  },
  publishAppraisalRecord: vi.fn(async () => "written"),
}));

vi.mock("@/lib/ponder-server", async () => {
  const schema = await import("../../indexer/ponder.schema");
  const chain = { from: () => chain, where: async () => state.cards };
  return { schema, ponderServer: () => ({ db: { select: () => chain } }) };
});
vi.mock("@/lib/scryfall", () => ({ scryfall: () => ({ getCard: async (id: string, opts: unknown) => { state.lookups.push({ id, opts }); return state.printings[id] ?? null; } }) }));
vi.mock("@/lib/market-price", () => ({ marketPriceForCard: vi.fn(async (card: { scryfallId: string }) => state.quotes[card.scryfallId] ?? null) }));
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    insert: () => ({ values: (values: Record<string, unknown>) => ({ onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => { state.inserts.push({ values, set }); } }) }),
  }),
}));

import { BUDGET_MS, GET, MAX_ENS_WRITES_PER_RUN } from "@/app/api/cron/prices/route";
import { MIN_SIGNER_BALANCE_WEI } from "@/lib/signer-floor";
import { defaultDeps as appraiseDeps } from "@/lib/appraise";
import { marketPriceForCard } from "@/lib/market-price";
import { publishAppraisalRecord } from "@/lib/appraise";

const call = () => GET(new Request("http://localhost/api/cron/prices", { headers: { authorization: "Bearer s3cret" } }));

const printing = (id: string, usd: string | null) => ({ id, prices: { usd, usd_foil: "9.00", usd_etched: null, eur: "1.00" } });
const quote = (fallback: string | null) => ({ usd: "1", source: { finish: "nonfoil", lang: "en", printingId: fallback, englishFallback: fallback != null }, conditionMultiplier: 1, adjustedUsd: "1" });

describe("cron prices", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "s3cret";
    state.inserts = [];
    state.lookups = [];
    state.ens = false;
    state.nodes = {};
    state.balance = 10n ** 17n;
    vi.mocked(publishAppraisalRecord).mockClear();
    vi.mocked(marketPriceForCard).mockClear();
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
    expect(await res.json()).toEqual({ updated: 3, total: 3, appraised: 0, appraisalErrors: 0 });
    const today = new Date().toISOString().slice(0, 10);
    expect(state.inserts.map((i) => i.values.scryfallId)).toEqual(["ja", "en", "en1"]);
    expect(state.inserts[1]!.values).toEqual({ scryfallId: "en", date: today, usd: "12.00", usdFoil: "9.00", usdEtched: null, eur: "1.00" });
  });

  it("reads every price past Scryfall's cache", async () => {
    state.cards = [{ id: 1n, scryfallId: "ja", condition: "NM" }];
    state.printings = { ja: printing("ja", null), en: printing("en", "12.00") };
    state.quotes = { ja: quote("en") };
    await GET(new Request("http://localhost/api/cron/prices", { headers: { authorization: "Bearer s3cret" } }));
    expect(state.lookups).toEqual([{ id: "ja", opts: { fresh: true } }, { id: "en", opts: { fresh: true } }]);
    // The printing just snapshotted is handed to the quote, not fetched a second time.
    expect(vi.mocked(marketPriceForCard)).toHaveBeenLastCalledWith(state.cards[0], expect.anything(), { fresh: true, printing: state.printings.ja, description: undefined });
  });

  it("stops cleanly past the time budget and says the run was partial", async () => {
    state.cards = [{ id: 1n, scryfallId: "a", condition: "NM" }, { id: 2n, scryfallId: "b", condition: "NM" }, { id: 3n, scryfallId: "c", condition: "NM" }];
    state.printings = { a: printing("a", "1.00"), b: printing("b", "2.00"), c: printing("c", "3.00") };
    state.quotes = {};
    // Each card "takes" 30s: the third starts past the 50s budget.
    let clock = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const slow = async () => { clock += 30_000; return null; };
    vi.mocked(marketPriceForCard).mockImplementationOnce(slow).mockImplementationOnce(slow);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await GET(new Request("http://localhost/api/cron/prices", { headers: { authorization: "Bearer s3cret" } }));
    now.mockRestore();
    const warned = warn.mock.calls.length;
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2, total: 3, appraised: 0, appraisalErrors: 0, partial: true });
    expect(state.inserts.map((i) => i.values.scryfallId)).toEqual(["a", "b"]);
    expect(warned).toBe(1);
    expect(BUDGET_MS).toBe(50_000);
  });

  describe("ENS appraisals", () => {
    const setup = () => {
      state.cards = [
        { id: 1n, scryfallId: "a", condition: "NM", state: "sharded" },
        { id: 2n, scryfallId: "b", condition: "NM", state: "auctioning" },
        { id: 3n, scryfallId: "c", condition: "NM", state: "whole" },
        { id: 4n, scryfallId: "d", condition: "NM", state: "sharded" }, // no price
      ];
      state.printings = { a: printing("a", "10.00"), b: printing("b", "20.00"), c: printing("c", "30.00"), d: printing("d", null) };
      state.quotes = { a: { ...quote(null), adjustedUsd: "8.5" }, b: { ...quote(null), adjustedUsd: "20" }, c: quote(null), d: { ...quote(null), usd: null, adjustedUsd: null } };
      state.nodes = { "1": "0xn1", "2": "0xn2", "3": "0xn3", "4": "0xn4" };
    };

    it("writes nothing when APPRAISER_WRITE_ENS is off", async () => {
      setup();
      expect(await (await call()).json()).toEqual({ updated: 4, total: 4, appraised: 0, appraisalErrors: 0 });
      expect(publishAppraisalRecord).not.toHaveBeenCalled();
    });

    it("publishes sharded and auctioning cards at their market price through the buyout path, skipping whole and unpriced cards", async () => {
      setup();
      state.ens = true;
      expect(await (await call()).json()).toEqual({ updated: 4, total: 4, appraised: 2, appraisalErrors: 0 });
      expect(vi.mocked(publishAppraisalRecord).mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([[1n, "0xn1", "8.5"], [2n, "0xn2", "20"]]);
      // Priced with the card's own mint description, as runAppraise prices it.
      expect(vi.mocked(marketPriceForCard).mock.calls[0]![2]).toMatchObject({ description: "a card, foil" });
    });

    it("counts a deduplicated write as not appraised, and a failed or unconfirmed one as an error without failing the snapshot", async () => {
      setup();
      state.ens = true;
      vi.mocked(publishAppraisalRecord).mockResolvedValueOnce("unchanged").mockResolvedValueOnce("failed");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await call();
      const warned = warn.mock.calls.length;
      warn.mockRestore();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ updated: 4, total: 4, appraised: 0, appraisalErrors: 1 });
      expect(state.inserts).toHaveLength(4);
      expect(warned).toBe(1);
      vi.mocked(publishAppraisalRecord).mockResolvedValueOnce("timeout");
      state.inserts = [];
      const silent = vi.spyOn(console, "warn").mockImplementation(() => {});
      // A timeout also stops the run's writes: the next card waits for tomorrow.
      expect(await (await call()).json()).toMatchObject({ appraised: 0, appraisalErrors: 1, partial: true });
      silent.mockRestore();
    });

    it("stops starting ENS writes near the time budget and says the run was partial", async () => {
      setup();
      state.ens = true;
      let clock = 1_000_000;
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      // The first card's write fits; by the second card only 4 s of the budget are left, less than a write's wait.
      vi.mocked(publishAppraisalRecord).mockImplementationOnce(async () => { clock += BUDGET_MS - 4_000; return "written"; });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const body = await (await call()).json();
      now.mockRestore();
      warn.mockRestore();
      expect(body).toEqual({ updated: 4, total: 4, appraised: 1, appraisalErrors: 0, partial: true });
      expect(publishAppraisalRecord).toHaveBeenCalledTimes(1);
    });

    const quiet = () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      return () => { const n = warn.mock.calls.length; warn.mockRestore(); return n; };
    };

    it(`writes at most ${MAX_ENS_WRITES_PER_RUN} appraisals per run, the rest deferred`, async () => {
      const n = MAX_ENS_WRITES_PER_RUN + 3;
      state.cards = Array.from({ length: n }, (_, i) => ({ id: BigInt(i + 1), scryfallId: `p${i}`, condition: "NM", state: "sharded" }));
      state.printings = Object.fromEntries(state.cards.map((_, i) => [`p${i}`, printing(`p${i}`, "5.00")]));
      state.quotes = Object.fromEntries(state.cards.map((_, i) => [`p${i}`, { ...quote(null), adjustedUsd: "5" }]));
      state.nodes = Object.fromEntries(state.cards.map((_, i) => [String(i + 1), `0xn${i}`]));
      state.ens = true;
      const done = quiet();
      expect(await (await call()).json()).toEqual({ updated: n, total: n, appraised: MAX_ENS_WRITES_PER_RUN, appraisalErrors: 0, partial: true });
      expect(done()).toBe(1);
      expect(publishAppraisalRecord).toHaveBeenCalledTimes(MAX_ENS_WRITES_PER_RUN);
    });

    it("writes no appraisals while the signer is under the floor, or its balance can't be read", async () => {
      setup();
      state.ens = true;
      state.balance = MIN_SIGNER_BALANCE_WEI - 1n;
      let done = quiet();
      expect(await (await call()).json()).toEqual({ updated: 4, total: 4, appraised: 0, appraisalErrors: 0 });
      expect(done()).toBe(1);
      state.balance = new Error("rpc down");
      done = quiet();
      expect(await (await call()).json()).toEqual({ updated: 4, total: 4, appraised: 0, appraisalErrors: 0 });
      done();
      expect(publishAppraisalRecord).not.toHaveBeenCalled();
      // Read once per run, at the floor it writes.
      state.balance = MIN_SIGNER_BALANCE_WEI;
      vi.mocked(appraiseDeps.signerBalance).mockClear();
      await call();
      expect(appraiseDeps.signerBalance).toHaveBeenCalledOnce();
      expect(publishAppraisalRecord).toHaveBeenCalledTimes(2);
    });

    for (const stop of ["timeout", "no-funds", "stuck"] as const) {
      it(`stops starting writes after a ${stop}, the rest deferred`, async () => {
        setup();
        state.ens = true;
        vi.mocked(publishAppraisalRecord).mockResolvedValueOnce(stop);
        const done = quiet();
        const body = await (await call()).json();
        done();
        expect(body).toEqual({ updated: 4, total: 4, appraised: 0, appraisalErrors: stop === "stuck" ? 0 : 1, partial: true });
        expect(publishAppraisalRecord).toHaveBeenCalledOnce();
      });
    }

    it("still snapshots the English fallback when the ENS name can't be read", async () => {
      state.cards = [{ id: 1n, scryfallId: "ja", condition: "NM", state: "sharded" }];
      state.printings = { ja: printing("ja", null), en: printing("en", "12.00") };
      state.quotes = { ja: { ...quote("en"), adjustedUsd: "12" } };
      state.ens = true;
      vi.mocked(appraiseDeps.loadEnsNode).mockRejectedValueOnce(new Error("indexer down"));
      const done = quiet();
      const body = await (await call()).json();
      expect(done()).toBe(1);
      expect(body).toEqual({ updated: 2, total: 1, appraised: 0, appraisalErrors: 0 });
      expect(state.inserts.map((i) => i.values.scryfallId)).toEqual(["ja", "en"]);
      expect(publishAppraisalRecord).not.toHaveBeenCalled();
    });
  });
});
