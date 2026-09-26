import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

// The cron through the real appraisal path (lib/appraise: queue, advisory lock, claim row, stuck check, nonce), with
// only the chain, the indexer and Scryfall faked. Nothing reaches a network.
const chain = vi.hoisted(() => ({
  latest: 10,
  pending: 10,
  sent: [] as { nonce: number; hash: Hex }[],
}));

vi.mock("viem", async (orig) => {
  const real = await orig<typeof import("viem")>();
  const reader = {
    getTransactionCount: async ({ blockTag }: { blockTag: "pending" | "latest" }) => (blockTag === "pending" ? chain.pending : chain.latest),
    // Nothing mines during the run: every write stays pending, like the ~12 s before a block.
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => { throw new real.TransactionReceiptNotFoundError({ hash }); },
    getBalance: async () => 10n ** 17n,
  };
  const wallet = {
    writeContract: async ({ nonce }: { nonce: number }) => {
      if (nonce !== chain.pending) throw new Error(`nonce ${nonce}, expected ${chain.pending}`);
      const hash = `0x${(0xaa00 + nonce).toString(16).padStart(64, "0")}` as Hex;
      chain.sent.push({ nonce, hash });
      chain.pending++;
      return hash;
    },
  };
  return { ...real, createPublicClient: () => reader, createWalletClient: () => wallet, http: () => ({}) };
});
vi.mock("@/env", () => ({ serverEnv: () => ({ ALCHEMY_HTTP_URL: "http://chain.invalid" }) }));
vi.mock("@/lib/ponder-server", async () => {
  const schema = await import("../../indexer/ponder.schema");
  const cards = [
    { id: 1n, scryfallId: "a", condition: "NM", state: "sharded" },
    { id: 2n, scryfallId: "b", condition: "NM", state: "sharded" },
  ];
  const select = () => ({
    from: (table: unknown) => ({
      where: () => {
        const rows = table === schema.cards ? cards : [];
        return Object.assign(Promise.resolve(rows), {
          limit: async () => (table === schema.ensNames ? [{ node: `0x${"11".repeat(32)}` }] : []),
        });
      },
    }),
  });
  return { schema, ponderServer: () => ({ db: { select } }) };
});
vi.mock("@/lib/scryfall", () => ({
  scryfall: () => ({ getCard: async (id: string) => ({ id, prices: { usd: "10.00", usd_foil: null, usd_etched: null, eur: null } }) }),
  ScryfallUnavailableError: class extends Error {},
}));
vi.mock("@/lib/market-price", () => ({
  marketPriceForCard: async (card: { scryfallId: string }) => ({
    usd: "10.00", adjustedUsd: card.scryfallId === "a" ? "10" : "20", conditionMultiplier: 1,
    source: { finish: "nonfoil", lang: "en", printingId: card.scryfallId, englishFallback: false },
  }),
  mintDescription: async () => null,
}));

import { createTestDb } from "@/lib/db/migrate";
import { ensAppraisalWrites } from "@/lib/db/schema";
import { resetAppraisalWritesForTests } from "@/lib/appraise";
import { GET } from "@/app/api/cron/prices/route";

describe("cron prices through the real appraisal path", () => {
  beforeEach(async () => {
    await createTestDb();
    resetAppraisalWritesForTests();
    chain.latest = 10;
    chain.pending = 10;
    chain.sent = [];
    process.env.CRON_SECRET = "s3cret";
    process.env.APPRAISER_WRITE_ENS = "true";
    process.env.SIGNER_PRIVATE_KEY = `0x${"a1".repeat(32)}`;
  });
  afterEach(() => {
    delete process.env.APPRAISER_WRITE_ENS;
  });

  it("writes both sharded cards, the second queued behind the first's still-unmined tx", async () => {
    const res = await GET(new Request("http://localhost/api/cron/prices", { headers: { authorization: "Bearer s3cret" } }));
    expect(await res.json()).toEqual({ updated: 2, total: 2, appraised: 2, appraisalErrors: 0 });
    // Card 2 went out on the next nonce while card 1's write was pending (pending = latest + 1): not "stuck".
    expect(chain.sent.map((s) => s.nonce)).toEqual([10, 11]);
    const { getDb } = await import("@/lib/db/client");
    const rows = await getDb().select().from(ensAppraisalWrites);
    expect(rows.map((r) => [r.cardId, r.usd, r.txHash]).sort()).toEqual([[1n, "10", chain.sent[0]!.hash], [2n, "20", chain.sent[1]!.hash]]);
  });

  it("skips as stuck behind an old write that never mined", async () => {
    const { getDb } = await import("@/lib/db/client");
    const now = Math.floor(Date.now() / 1000);
    // A write from ten minutes ago, for another card, is still not mined, and the queue is blocked behind it.
    await getDb().insert(ensAppraisalWrites).values({ cardId: 9n, usd: "5", at: BigInt(now - 600), txHash: `0x${"99".repeat(32)}` });
    chain.pending = 11;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await GET(new Request("http://localhost/api/cron/prices", { headers: { authorization: "Bearer s3cret" } }));
    warn.mockRestore();
    expect(await res.json()).toEqual({ updated: 2, total: 2, appraised: 0, appraisalErrors: 0, partial: true });
    expect(chain.sent).toEqual([]);
    // The skipped card's claim was put back (none left for cards 1 and 2).
    expect((await getDb().select().from(ensAppraisalWrites)).map((r) => r.cardId)).toEqual([9n]);
  });
});
