import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { createTestDb } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { ensAppraisalWrites } from "@/lib/db/schema";
import { resetAppraisalWritesForTests, type DbTx, type Deps } from "@/lib/appraise";
import { publishSettledAppraisal } from "@/lib/settled-appraisal";
import { MIN_SIGNER_BALANCE_WEI } from "@/lib/signer-floor";

const NODE = `0x${"11".repeat(32)}` as Hex;
const HASH = `0x${"aa".repeat(32)}` as Hex;
const shardToken = "0x3333333333333333333333333333333333333333" as const;
// The webhook can beat the indexer to the settle: the card may still read "auctioning".
const card = { id: 7n, scryfallId: "x", condition: "NM", shardToken, state: "auctioning" };
const priced = { quote: { usd: "100.00", adjustedUsd: "100", conditionMultiplier: 1, source: { finish: "nonfoil" as const, lang: "en", printingId: "x", englishFallback: false } }, source: "scryfall" as const, pricedAt: 1 };

function deps(over: Partial<Deps> = {}): Deps {
  return {
    loadCard: vi.fn(async () => card),
    loadSharding: vi.fn(async () => null),
    loadEnsNode: vi.fn(async () => NODE),
    loadEnsText: vi.fn(async (_node: Hex, key: string) => (key === "description" ? "a card" : null)),
    price: vi.fn(async () => priced),
    writeEnsRecord: vi.fn(async () => HASH),
    signerBalance: vi.fn(async () => 10n ** 17n),
    ensWritesEnabled: () => true,
    ensWriteLock: vi.fn(async (_id: bigint, fn: () => Promise<void>, claim?: (tx: DbTx) => Promise<boolean>) => {
      if (claim && !(await claim(getDb() as unknown as DbTx))) return true;
      await fn();
      return true;
    }),
    ...over,
  };
}

describe("publishSettledAppraisal", () => {
  beforeEach(async () => {
    await createTestDb();
    resetAppraisalWritesForTests();
  });

  it("publishes the card's market price through publishAppraisalRecord, once", async () => {
    const d = deps();
    expect(await publishSettledAppraisal(7n, d)).toBe("written");
    expect(d.price).toHaveBeenCalledWith(card, "a card");
    expect(d.writeEnsRecord).toHaveBeenCalledWith(NODE, "100");
    expect((await getDb().select().from(ensAppraisalWrites)).map((r) => [r.cardId, r.usd, r.txHash])).toEqual([[7n, "100", HASH]]);
    expect(await publishSettledAppraisal(7n, d)).toBe("unchanged");
    expect(d.writeEnsRecord).toHaveBeenCalledTimes(1);
  });

  it("respects APPRAISER_WRITE_ENS and the cron's signer floor", async () => {
    const off = deps({ ensWritesEnabled: () => false });
    expect(await publishSettledAppraisal(7n, off)).toBe("disabled");
    expect(off.loadCard).not.toHaveBeenCalled();
    const poor = deps({ signerBalance: vi.fn(async () => MIN_SIGNER_BALANCE_WEI - 1n) });
    expect(await publishSettledAppraisal(7n, poor)).toBe("low-funds");
    expect(poor.writeEnsRecord).not.toHaveBeenCalled();
    expect(await publishSettledAppraisal(7n, deps({ signerBalance: vi.fn(async () => MIN_SIGNER_BALANCE_WEI) }))).toBe("written");
  });

  it("skips a card that is gone, whole again, unnamed or unpriced", async () => {
    expect(await publishSettledAppraisal(7n, deps({ loadCard: vi.fn(async () => null) }))).toBe("no-card");
    expect(await publishSettledAppraisal(7n, deps({ loadCard: vi.fn(async () => ({ ...card, state: "whole" })) }))).toBe("not-sharded");
    expect(await publishSettledAppraisal(7n, deps({ loadEnsNode: vi.fn(async () => null) }))).toBe("no-name");
    expect(await publishSettledAppraisal(7n, deps({ price: vi.fn(async () => ({ quote: null, source: null, pricedAt: null })) }))).toBe("no-price");
  });

  it("throws when the indexer is unreachable, so the webhook asks for a retry", async () => {
    await expect(publishSettledAppraisal(7n, deps({ loadCard: vi.fn(async () => { throw new Error("fetch failed"); }) }))).rejects.toThrow("fetch failed");
  });
});
