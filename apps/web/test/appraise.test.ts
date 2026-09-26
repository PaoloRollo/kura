import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, namehash, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { APPRAISAL_TYPES, abi, cardVaultDomain, dnsEncodeName, usdcPerShardToQ96 } from "@kura/shared";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/migrate";
import { appraisals, ensAppraisalWrites } from "@/lib/db/schema";
import { deployments, resetDeploymentsForTests, setDeploymentsForTests } from "@/lib/deployments";
import { ENS_REWRITE_SEC, ENS_WRITE_TIMEOUT_MS, appraisalDnsName, appraisalTextCalls, computeUsdcPerShard, publishAppraisalRecord, lookupPrice, needsEnsWrite, pgEnsWriteLock, resetAppraisalWritesForTests, runAppraise, runAppraiseFor, STALE_CLAIM_SEC, lastOldAppraisalTx, sendUnlessStuck, sendWithFreshNonce, type DbTx, type StuckCheck, type Deps, type PriceLookup } from "@/lib/appraise";
import { marketPrices } from "@/lib/db/schema";
import type { PriceQuote } from "@/lib/pricing";
import { signerAddress } from "@/lib/signer";
import { Scryfall } from "@/lib/scryfall";
import { marketPriceForCard } from "@/lib/market-price";
import { getDb as getDbForTest, setDbForTests, type AnyDb } from "@/lib/db/client";

const KEY = ("0x" + "a1".repeat(32)) as Hex;
const shardToken = "0x3333333333333333333333333333333333333333" as const;
const card = { id: 1n, scryfallId: "x", condition: "NM", shardToken, state: "sharded" };
const sharding = { shardToken, cardId: 1n, totalShards: 16, settled: true, redeemer: null, clearingUsdcPerShard: 10_000_000n, clearingPriceQ96: usdcPerShardToQ96(10_000_000n) };

function quote(usd: string | null, m = 1, adjusted = usd): PriceQuote {
  return { usd, source: { finish: "nonfoil", lang: "en", printingId: usd ? "x" : null, englishFallback: false }, conditionMultiplier: m, adjustedUsd: adjusted };
}
const priced = (q: PriceQuote, source: PriceLookup["source"] = "scryfall"): PriceLookup => ({ quote: q, source, pricedAt: 1_700_000_000 });

/** A fake `getDb()` whose `.transaction()` only ever grants the lock, so we can observe how long it stays open. */
function fakeLockDb() {
  let open = 0;
  let maxOpen = 0;
  const transaction = async (cb: (tx: { execute: (q: unknown) => Promise<{ rows: { locked: boolean }[] }> }) => Promise<unknown>) => {
    open++;
    maxOpen = Math.max(maxOpen, open);
    try {
      return await cb({ execute: async () => ({ rows: [{ locked: true }] }) });
    } finally {
      open--;
    }
  };
  return { db: { transaction } as unknown as AnyDb, isOpen: () => open > 0, maxOpen: () => maxOpen };
}

function deps(over: Partial<Deps> = {}): Deps {
  return {
    loadCard: vi.fn(async () => card),
    loadSharding: vi.fn(async () => sharding),
    loadEnsNode: vi.fn(async () => null),
    loadEnsText: vi.fn(async () => null),
    price: vi.fn(async () => priced(quote("192.00"))),
    writeEnsRecord: vi.fn(async () => undefined),
    ensWritesEnabled: () => true,
    signerBalance: vi.fn(async () => 10n ** 17n),
    // The claim runs against the test database, as pgEnsWriteLock runs it inside its transaction.
    ensWriteLock: vi.fn(async (_id: bigint, fn: () => Promise<void>, claim?: (tx: DbTx) => Promise<boolean>) => {
      if (claim && !(await claim(getDbForTest() as unknown as DbTx))) return true;
      await fn();
      return true;
    }),
    ...over,
  };
}

describe("appraise", () => {
  let db: AnyDb;
  beforeEach(async () => {
    db = await createTestDb();
    process.env.SIGNER_PRIVATE_KEY = KEY;
    setDeploymentsForTests({ ...deployments(), signer: privateKeyToAccount(KEY).address });
    resetAppraisalWritesForTests();
  });
  afterEach(() => resetDeploymentsForTests());

  it("computes floor(price * 1e6 / shards)", () => {
    expect(computeUsdcPerShard("160.00", 16)).toBe(10_000_000n);
    expect(computeUsdcPerShard("0.005", 512)).toBe(9n);
    expect(computeUsdcPerShard("25000", 16)).toBe(1_562_500_000n);
  });

  it("signs an appraisal from the market price and records its source", async () => {
    const out = await runAppraise({ cardId: "1" }, deps());
    expect(out.appraisal.usdcPerShard).toBe("12000000");
    expect(out.marketUsd).toBe("192.00");
    expect(out.clearingUsdcPerShard).toBe("10000000");
    const ok = await verifyTypedData({
      address: signerAddress(), domain: cardVaultDomain(deployments().cardVault), types: APPRAISAL_TYPES, primaryType: "Appraisal",
      message: { cardId: 1n, shardToken, usdcPerShard: 12_000_000n, expiresAt: BigInt(out.appraisal.expiresAt) }, signature: out.signature,
    });
    expect(ok).toBe(true);
    expect(Number(out.appraisal.expiresAt)).toBeGreaterThan(Date.now() / 1000 + 500);
    expect(Number(out.appraisal.expiresAt)).toBeLessThanOrEqual(Date.now() / 1000 + 600);
    const rows = await db.select().from(appraisals).where(eq(appraisals.cardId, 1n));
    expect(rows).toHaveLength(1);
    expect(rows[0].priceSource).toBe("Scryfall USD · nonfoil · EN printing · NM ×1.00");
    expect(Number(rows[0].conditionMultiplier)).toBe(1);
  });

  it("appraises at the condition-adjusted price", async () => {
    const out = await runAppraise({ cardId: "1" }, deps({ loadCard: vi.fn(async () => ({ ...card, condition: "LP" })), price: vi.fn(async () => priced(quote("200.00", 0.85, "170.00"))) }));
    expect(out.appraisal.usdcPerShard).toBe(String(170_000_000n / 16n));
    expect(out.conditionMultiplier).toBe(0.85);
    expect(out.priceSource).toContain("LP ×0.85");
  });

  it("quotes the clearing price from Q96 when the auction did not graduate", async () => {
    const out = await runAppraise({ cardId: "1" }, deps({ loadSharding: vi.fn(async () => ({ ...sharding, clearingUsdcPerShard: null, clearingPriceQ96: usdcPerShardToQ96(1_712_000_000n) })) }));
    expect(out.clearingUsdcPerShard).toBe("1712000000");
  });

  it("labels a cached price as a snapshot", async () => {
    const out = await runAppraise({ cardId: "1" }, deps({ price: vi.fn(async () => priced(quote("192.00"), "snapshot")) }));
    expect(out.source).toBe("snapshot");
    expect(out.pricedAt).toBe(1_700_000_000);
    expect(out.priceSource).toMatch(/cached$/);
  });

  it("passes the mint description to the price lookup and writes the ENS record", async () => {
    const text: Record<string, string> = { description: "Black Lotus, Limited Edition Alpha, foil" };
    const d = deps({ loadEnsNode: vi.fn(async () => "0xabc" as Hex), loadEnsText: vi.fn(async (_n: Hex, k: string) => text[k] ?? null) });
    await runAppraise({ cardId: "1" }, d);
    expect(d.loadEnsText).toHaveBeenCalledWith("0xabc", "description");
    expect(d.price).toHaveBeenCalledWith(card, "Black Lotus, Limited Edition Alpha, foil");
    expect(d.writeEnsRecord).toHaveBeenCalledTimes(1);
    expect(d.writeEnsRecord).toHaveBeenCalledWith("0xabc", "192.00");
    // Same price again: this instance just wrote it, so no second write (the indexer may not have it yet).
    await runAppraise({ cardId: "1" }, d);
    expect(d.writeEnsRecord).toHaveBeenCalledTimes(1);
  });

  it("writes the ENS record only when the price changed or the record is an hour old", async () => {
    const now = Math.floor(Date.now() / 1000);
    const text: Record<string, string> = { "appraisal.usd": "192.00", "appraisal.at": String(now - 60) };
    const d = deps({ loadEnsNode: vi.fn(async () => "0xabc" as Hex), loadEnsText: vi.fn(async (_n: Hex, k: string) => text[k] ?? null) });
    await runAppraise({ cardId: "1" }, d);
    expect(d.writeEnsRecord).not.toHaveBeenCalled();
    text["appraisal.at"] = String(now - ENS_REWRITE_SEC);
    await runAppraise({ cardId: "1" }, d);
    expect(d.writeEnsRecord).toHaveBeenCalledTimes(1);
    expect(needsEnsWrite({ usd: "192", at: now }, "192.00", now)).toBe(false);
    expect(needsEnsWrite({ usd: "190.00", at: now }, "192.00", now)).toBe(true);
    expect(needsEnsWrite({ usd: null, at: null }, "192.00", now)).toBe(true);
  });

  it("awaits the ENS write, dedupes concurrent requests, and survives a failing write", async () => {
    let release!: () => void;
    const writeEnsRecord = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const d = deps({ loadEnsNode: vi.fn(async () => "0xabc" as Hex), writeEnsRecord });
    let done = false;
    const first = runAppraise({ cardId: "1" }, d).then((x) => { done = true; return x; });
    await vi.waitFor(() => expect(writeEnsRecord).toHaveBeenCalledTimes(1));
    await runAppraise({ cardId: "1" }, d); // in flight: skipped, answers at once
    expect(writeEnsRecord).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    release();
    await first;
    const failing = deps({ loadEnsNode: vi.fn(async () => "0xdef" as Hex), loadCard: vi.fn(async () => ({ ...card, id: 2n })), writeEnsRecord: vi.fn(async () => { throw new Error("no gas"); }) });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runAppraise({ cardId: "2" }, failing)).resolves.toMatchObject({ marketUsd: "192.00" });
    errSpy.mockRestore();
  });

  it("registers the write in flight before any await, so concurrent requests write once", async () => {
    const d = deps({
      loadEnsNode: vi.fn(async () => "0xabc" as Hex),
      loadEnsText: vi.fn(async (_n: Hex, k: string) => { if (k.startsWith("appraisal.")) await new Promise((r) => setTimeout(r, 20)); return null; }),
    });
    await Promise.all([runAppraise({ cardId: "1" }, d), runAppraise({ cardId: "1" }, d), runAppraise({ cardId: "1" }, d)]);
    expect(d.writeEnsRecord).toHaveBeenCalledTimes(1);
  });

  it("skips the write when another instance holds the card's lock, and when writes are off", async () => {
    const locked = deps({ loadEnsNode: vi.fn(async () => "0xabc" as Hex), ensWriteLock: vi.fn(async () => false) });
    await expect(runAppraise({ cardId: "1" }, locked)).resolves.toMatchObject({ marketUsd: "192.00" });
    expect(locked.ensWriteLock).toHaveBeenCalledWith(1n, expect.any(Function), expect.any(Function));
    expect(locked.writeEnsRecord).not.toHaveBeenCalled();
    const off = deps({ loadEnsNode: vi.fn(async () => "0xabc" as Hex), ensWritesEnabled: () => false });
    await runAppraise({ cardId: "1" }, off);
    expect(off.ensWriteLock).not.toHaveBeenCalled();
    expect(off.writeEnsRecord).not.toHaveBeenCalled();
  });

  it("says what publishAppraisalRecord did, for the cron's counts", async () => {
    const d = deps();
    expect(await publishAppraisalRecord(5n, "0xabc", "8.50", deps({ ensWritesEnabled: () => false }))).toBe("disabled");
    expect(await publishAppraisalRecord(5n, "0xabc", "8.50", d)).toBe("written");
    expect(d.writeEnsRecord).toHaveBeenCalledWith("0xabc", "8.50");
    // The same price again within the hour: deduplicated.
    expect(await publishAppraisalRecord(5n, "0xabc", "8.50", d)).toBe("unchanged");
    expect(await publishAppraisalRecord(6n, "0xabc", "8.50", deps({ ensWriteLock: vi.fn(async () => false) }))).toBe("locked");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await publishAppraisalRecord(7n, "0xabc", "8.50", deps({ writeEnsRecord: vi.fn(async () => { throw new Error("no gas"); }) }))).toBe("failed");
    err.mockRestore();
  });

  it("claims the write in Postgres, so a second instance (nothing in memory) doesn't send it again", async () => {
    const TX = `0x${"ab".repeat(32)}` as Hex;
    const a = deps({ ensWriteLock: pgEnsWriteLock, writeEnsRecord: vi.fn(async () => TX) });
    expect(await publishAppraisalRecord(5n, "0xabc", "8.50", a)).toBe("written");
    expect(await db.select().from(ensAppraisalWrites)).toMatchObject([{ cardId: 5n, usd: "8.50", txHash: TX }]);
    // Another instance (or an overlapping cron run): its memory is empty and the indexer hasn't caught up.
    resetAppraisalWritesForTests();
    const b = deps({ ensWriteLock: pgEnsWriteLock, writeEnsRecord: vi.fn(async () => TX) });
    expect(await publishAppraisalRecord(5n, "0xabc", "8.50", b)).toBe("unchanged");
    expect(b.writeEnsRecord).not.toHaveBeenCalled();
    // A new price is claimed and sent.
    expect(await publishAppraisalRecord(5n, "0xabc", "9.00", b)).toBe("written");
    expect(b.writeEnsRecord).toHaveBeenCalledWith("0xabc", "9.00");
  });

  it("puts the claim back when the send fails or the signer is stuck, so the next attempt can send", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const TX = `0x${"cd".repeat(32)}` as Hex;
    await publishAppraisalRecord(5n, "0xabc", "8.50", deps({ ensWriteLock: pgEnsWriteLock, writeEnsRecord: vi.fn(async () => TX) }));
    resetAppraisalWritesForTests();
    const failing = deps({ ensWriteLock: pgEnsWriteLock, writeEnsRecord: vi.fn(async () => { throw new Error("socket hang up"); }) });
    expect(await publishAppraisalRecord(5n, "0xabc", "9.00", failing)).toBe("failed");
    expect(await db.select().from(ensAppraisalWrites)).toMatchObject([{ usd: "8.50", txHash: TX }]);
    const broke = deps({ ensWriteLock: pgEnsWriteLock, writeEnsRecord: vi.fn(async () => { throw Object.assign(new Error("x"), { shortMessage: "insufficient funds for gas * price + value" }); }) });
    expect(await publishAppraisalRecord(6n, "0xabc", "9.00", broke)).toBe("no-funds");
    expect(await db.select().from(ensAppraisalWrites).where(eq(ensAppraisalWrites.cardId, 6n))).toEqual([]);
    const stuck = deps({ ensWriteLock: pgEnsWriteLock, writeEnsRecord: vi.fn(async () => "stuck" as const) });
    expect(await publishAppraisalRecord(5n, "0xabc", "9.00", stuck)).toBe("stuck");
    expect(await db.select().from(ensAppraisalWrites)).toMatchObject([{ usd: "8.50", txHash: TX }]);
    const ok = deps({ ensWriteLock: pgEnsWriteLock, writeEnsRecord: vi.fn(async () => TX) });
    expect(await publishAppraisalRecord(5n, "0xabc", "9.00", ok)).toBe("written");
    err.mockRestore();
  });

  it("sends right after the signer's own write (pending = latest + 1), and skips only behind an old unmined write", async () => {
    const OLD = `0x${"0e".repeat(32)}` as Hex;
    const send = vi.fn(async () => "0x01" as Hex);
    const check = (over: Partial<StuckCheck> = {}): StuckCheck => ({
      lastOldWrite: vi.fn(async () => null), mined: vi.fn(async () => false), nonces: vi.fn(async () => ({ pending: 12, latest: 11 })), ...over,
    });
    // A write seconds ago is still in flight: no old write, so the new one queues behind it on the pending nonce.
    expect(await sendUnlessStuck(send, check())).toBe("0x01");
    // An old write that has since been mined: send.
    expect(await sendUnlessStuck(send, check({ lastOldWrite: vi.fn(async () => OLD), mined: vi.fn(async () => true) }))).toBe("0x01");
    // An old write unmined but the queue is clear (it was replaced): send.
    expect(await sendUnlessStuck(send, check({ lastOldWrite: vi.fn(async () => OLD), nonces: vi.fn(async () => ({ pending: 12, latest: 12 })) }))).toBe("0x01");
    expect(send).toHaveBeenCalledTimes(3);
    // An old write unmined and txs pending: stuck.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await sendUnlessStuck(send, check({ lastOldWrite: vi.fn(async () => OLD) }))).toBe("stuck");
    expect(send).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("finds the newest write sent over two minutes (and under a day) ago", async () => {
    const now = 2_000_000_000;
    const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
    await db.insert(ensAppraisalWrites).values([
      { cardId: 1n, usd: "1", at: BigInt(now - 30), txHash: h(1) }, // in flight, not old
      { cardId: 2n, usd: "1", at: BigInt(now - 600), txHash: h(2) },
      { cardId: 3n, usd: "1", at: BigInt(now - 900), txHash: h(3) },
      { cardId: 4n, usd: "1", at: BigInt(now - 400), txHash: null }, // claimed, never sent
      { cardId: 5n, usd: "1", at: BigInt(now - 2 * 86_400), txHash: h(5) }, // too old to matter
    ]);
    expect(await lastOldAppraisalTx(now)).toBe(h(2));
    expect(await lastOldAppraisalTx(now + 2 * 86_400)).toBeNull();
  });

  it("takes over a claim that never got a tx hash after five minutes, and never restores over a newer claim", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Math.floor(Date.now() / 1000);
    // A writer crashed between its claim and its send.
    await db.insert(ensAppraisalWrites).values({ cardId: 5n, usd: "8.50", at: BigInt(now - STALE_CLAIM_SEC), txHash: null });
    const TX = `0x${"ef".repeat(32)}` as Hex;
    const d = deps({ ensWriteLock: pgEnsWriteLock, writeEnsRecord: vi.fn(async () => TX) });
    expect(await publishAppraisalRecord(5n, "0xabc", "8.50", d)).toBe("written");
    // A fresh unsent claim (someone sending right now) is respected.
    await db.insert(ensAppraisalWrites).values({ cardId: 6n, usd: "8.50", at: BigInt(now - 10), txHash: null });
    expect(await publishAppraisalRecord(6n, "0xabc", "8.50", d)).toBe("unchanged");
    // Our send fails after another writer took a newer claim: their row stays.
    const racing = deps({
      ensWriteLock: pgEnsWriteLock,
      writeEnsRecord: vi.fn(async () => {
        await db.update(ensAppraisalWrites).set({ usd: "9.99", at: BigInt(now + 5), txHash: TX }).where(eq(ensAppraisalWrites.cardId, 7n));
        throw new Error("socket hang up");
      }),
    });
    expect(await publishAppraisalRecord(7n, "0xabc", "9.00", racing)).toBe("failed");
    expect(await db.select().from(ensAppraisalWrites).where(eq(ensAppraisalWrites.cardId, 7n))).toMatchObject([{ usd: "9.99", txHash: TX }]);
    err.mockRestore();
  });

  it("answers busy to a concurrent publish of the same card, and timeout when the send outlasts the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let release!: () => void;
      const slow = deps({ writeEnsRecord: vi.fn(() => new Promise<void>((r) => { release = r; })) });
      const first = publishAppraisalRecord(5n, "0xabc", "8.50", slow);
      expect(await publishAppraisalRecord(5n, "0xabc", "8.50", slow)).toBe("busy");
      await vi.waitFor(() => expect(slow.writeEnsRecord).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(ENS_WRITE_TIMEOUT_MS);
      expect(await first).toBe("timeout");
      release();
      await vi.runAllTimersAsync();
    } finally {
      err.mockRestore();
      vi.useRealTimers();
    }
  });

  it("takes the Postgres advisory lock in a transaction", async () => {
    const fn = vi.fn(async () => undefined);
    await expect(pgEnsWriteLock(7n, fn)).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("queues a write behind another instead of holding a DB transaction open while it waits", async () => {
    const { db: fakeDb, isOpen, maxOpen } = fakeLockDb();
    setDbForTests(fakeDb);
    try {
      let releaseFirst!: () => void;
      const first = vi.fn(() => new Promise<void>((r) => { releaseFirst = r; }));
      const second = vi.fn(async () => undefined);

      const p1 = pgEnsWriteLock(1n, first);
      await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
      // Card 1's lock-check transaction already committed before its (still-pending) write runs.
      expect(isOpen()).toBe(false);

      const p2 = pgEnsWriteLock(2n, second);
      await new Promise((r) => setTimeout(r, 20));
      expect(second).not.toHaveBeenCalled(); // queued behind card 1's still-pending write
      expect(isOpen()).toBe(false); // and holds no DB transaction while it waits its turn

      releaseFirst();
      await expect(p1).resolves.toBe(true);
      await expect(p2).resolves.toBe(true);
      expect(second).toHaveBeenCalledTimes(1);
      expect(maxOpen()).toBe(1); // never more than one lock-check transaction open at a time
    } finally {
      await createTestDb();
    }
  });

  it("answers the same appraisal to a DID asking again within 10 s, without a new row", async () => {
    const d = deps();
    const first = await runAppraiseFor("did:1", { cardId: "1" }, d, 1_000_000);
    const again = await runAppraiseFor("did:1", { cardId: "1" }, d, 1_005_000);
    expect(again).toBe(first);
    await expect(runAppraiseFor("did:1", { cardId: "2" }, d, 1_006_000)).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    await runAppraiseFor("did:2", { cardId: "1" }, d, 1_006_000);
    await runAppraiseFor("did:1", { cardId: "1" }, d, 1_010_001);
    expect(await db.select().from(appraisals)).toHaveLength(3);
  });

  it("fails cleanly without a price, without a sharding, or after redemption", async () => {
    await expect(runAppraise({ cardId: "1" }, deps({ price: vi.fn(async () => ({ quote: quote(null), source: null, pricedAt: null })) }))).rejects.toMatchObject({ code: "NO_PRICE", status: 400 });
    await expect(runAppraise({ cardId: "1" }, deps({ price: vi.fn(async () => priced(quote("0.00"))) }))).rejects.toMatchObject({ code: "NO_PRICE" });
    await expect(runAppraise({ cardId: "1" }, deps({ loadSharding: vi.fn(async () => null) }))).rejects.toMatchObject({ code: "NOT_SHARDED", status: 409 });
    await expect(runAppraise({ cardId: "1" }, deps({ loadSharding: vi.fn(async () => ({ ...sharding, settled: false })) }))).rejects.toMatchObject({ code: "NOT_SHARDED" });
    await expect(runAppraise({ cardId: "1" }, deps({ loadCard: vi.fn(async () => ({ ...card, shardToken: null })) }))).rejects.toMatchObject({ code: "NOT_SHARDED" });
    await expect(runAppraise({ cardId: "1" }, deps({ loadSharding: vi.fn(async () => ({ ...sharding, redeemer: "0x0000000000000000000000000000000000000001" as const })) }))).rejects.toMatchObject({ code: "ALREADY_REDEEMED", status: 409 });
    await expect(runAppraise({ cardId: "1" }, deps({ loadCard: vi.fn(async () => null) }))).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

describe("sendWithFreshNonce", () => {
  // Shaped like viem's BaseError: `.message` is the full formatted dump (Request Arguments included) and always
  // mentions the nonce, so the retry check must never look at it — only at name/shortMessage/details, walking `cause`.
  function viemError(name: string, shortMessage: string, opts: { details?: string; cause?: unknown } = {}): Error {
    const err = new Error(`${name}: ${shortMessage}\n\nRequest Arguments:\n  nonce:  5\n`) as Error & { shortMessage: string; details?: string; cause?: unknown };
    err.name = name;
    err.shortMessage = shortMessage;
    err.details = opts.details;
    err.cause = opts.cause;
    return err;
  }
  const txExecutionError = (cause: unknown) => viemError("TransactionExecutionError", "An error occurred while executing the transaction.", { cause });

  it("retries once with a fresh nonce when the cause is NonceTooLow", async () => {
    const nonces = [4, 5];
    const pendingNonce = vi.fn(async () => nonces.shift()!);
    const cause = viemError("NonceTooLowError", "Nonce provided for the transaction is lower than the current nonce of the account.", { details: "nonce too low: next nonce 5, tx nonce 4" });
    const send = vi.fn(async (nonce: number) => { if (nonce === 4) throw txExecutionError(cause); return "0xhash" as Hex; });
    await expect(sendWithFreshNonce(send, pendingNonce)).resolves.toBe("0xhash");
    expect(send.mock.calls.map((c) => c[0])).toEqual([4, 5]);
  });

  it("does not retry a revert, even though the formatted message mentions the nonce", async () => {
    const cause = viemError("ContractFunctionRevertedError", "Execution reverted for an unknown reason.", { details: "execution reverted" });
    const send = vi.fn(async () => { throw txExecutionError(cause); });
    await expect(sendWithFreshNonce(send, async () => 5)).rejects.toThrow(/TransactionExecutionError/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries a replacement-underpriced or already-known error once, and never anything else", async () => {
    const underpriced = vi.fn(async () => {
      throw txExecutionError(viemError("TransactionUnderpricedError", "Replacement transaction is underpriced.", { details: "replacement transaction underpriced" }));
    });
    await expect(sendWithFreshNonce(underpriced, async () => 1)).rejects.toThrow();
    expect(underpriced).toHaveBeenCalledTimes(2);

    const alreadyKnown = vi.fn(async () => {
      throw txExecutionError(viemError("InternalRpcError", "An internal error was received.", { details: "already known" }));
    });
    await expect(sendWithFreshNonce(alreadyKnown, async () => 1)).rejects.toThrow();
    expect(alreadyKnown).toHaveBeenCalledTimes(2);

    const broke = vi.fn(async () => { throw new Error("insufficient funds for gas"); });
    await expect(sendWithFreshNonce(broke, async () => 1)).rejects.toThrow(/insufficient/);
    expect(broke).toHaveBeenCalledTimes(1);
  });
});

describe("lookupPrice", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  const lotus = {
    object: "card", id: "lotus", name: "Black Lotus", lang: "en", set: "lea", set_name: "Limited Edition Alpha", collector_number: "232",
    rarity: "rare", colors: [], type_line: "Artifact", cmc: 0, released_at: "1993-08-05", image_uris: { small: "s", normal: "n" },
    prices: { usd: "25400.00", usd_foil: null, eur: null }, finishes: ["nonfoil"],
  };
  const lotusCard = { id: 1n, scryfallId: "lotus", condition: "NM" };

  function client(body: unknown, start = 1_700_000_000_000) {
    const state = { clock: start, status: 200 };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: state.status })) as unknown as typeof fetch;
    return { s: new Scryfall({ fetchImpl, now: () => state.clock }), state };
  }

  it("prices live with the cache time, then falls back to the cached printing while Scryfall is busy", async () => {
    const { s, state } = client(lotus);
    const live = await lookupPrice(lotusCard, null, s);
    expect(live.source).toBe("scryfall");
    expect(live.quote?.adjustedUsd).toBe("25400");
    expect(live.pricedAt).toBe(1_700_000_000);

    state.clock += 3 * 24 * 60 * 60 * 1000; // past the cache TTL
    state.status = 429;
    vi.useFakeTimers({ now: state.clock, toFake: ["Date"] });
    try {
      const cached = await lookupPrice({ ...lotusCard, condition: "LP" }, null, s);
      expect(cached.source).toBe("snapshot");
      expect(cached.pricedAt).toBe(1_700_000_000);
      expect(cached.quote?.adjustedUsd).toBe("21590");
    } finally {
      vi.useRealTimers();
    }

    const unknown = await lookupPrice({ ...lotusCard, scryfallId: "nope" }, null, s);
    expect(unknown).toEqual({ quote: null, source: null, pricedAt: null });
  });

  it("treats a snapshot older than 7 days as no price", async () => {
    const { s, state } = client(lotus);
    await lookupPrice(lotusCard, null, s);
    state.clock += 8 * 24 * 60 * 60 * 1000;
    state.status = 429;
    vi.useFakeTimers({ now: state.clock, toFake: ["Date"] });
    try {
      expect(await lookupPrice(lotusCard, null, s)).toEqual({ quote: null, source: null, pricedAt: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prices a foil-only printing the same on the card page and in the appraisal", async () => {
    // A promo printed only in foil, minted without ", foil" in its description.
    const promo = { ...lotus, id: "promo", finishes: ["foil"], prices: { usd: null, usd_foil: "40.00", eur: null } };
    const { s } = client(promo);
    const description = "Sol Ring, Judge Gift Cards";
    const display = await marketPriceForCard({ id: 1n, scryfallId: "promo", condition: "NM" }, s, { description });
    const appraised = await lookupPrice({ id: 1n, scryfallId: "promo", condition: "NM" }, description, s);
    expect(display?.source.finish).toBe("foil");
    expect(display?.adjustedUsd).toBe("40");
    expect(appraised.quote).toEqual(display);
  });

  it("threads fresh through to both Scryfall lookups", async () => {
    // A Japanese printing with no USD price, so the quote also looks up the English printing.
    const ja = { ...lotus, id: "ja", lang: "ja", prices: { usd: null, usd_foil: null, eur: null } };
    const { s } = client(ja);
    const getCard = vi.spyOn(s, "getCard");
    const getPrinting = vi.spyOn(s, "getPrinting");
    await marketPriceForCard({ id: 1n, scryfallId: "ja", condition: "NM" }, s, { description: null, fresh: true });
    expect(getCard).toHaveBeenCalledWith("ja", { fresh: true });
    expect(getPrinting).toHaveBeenCalledWith(ja.set, ja.collector_number, "en", { fresh: true });
  });

  it("prices a printing the caller already fetched without fetching it again", async () => {
    const { s } = client(lotus);
    const getCard = vi.spyOn(s, "getCard");
    const q = await marketPriceForCard({ id: 1n, scryfallId: "lotus", condition: "NM" }, s, { description: null, printing: lotus as never });
    expect(getCard).not.toHaveBeenCalled();
    expect(q?.usd).toBe(lotus.prices.usd);
  });

  it("records the market price under the priced printing's id, etched included", async () => {
    const etched = { ...lotus, id: "etched", finishes: ["etched"], prices: { usd: null, usd_foil: null, usd_etched: "12.50", eur: null } };
    const { s } = client(etched);
    await lookupPrice({ id: 1n, scryfallId: "etched", condition: "NM" }, "Sol Ring, Commander Legends, etched", s);
    const rows = await getDbForTest().select().from(marketPrices);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scryfallId: "etched" });
    expect(Number(rows[0]!.usdEtched)).toBe(12.5);
  });

  it("records an English-fallback price under the English printing", async () => {
    const ja = { ...lotus, id: "ja", lang: "ja", prices: { usd: null, usd_foil: null, eur: null } };
    const en = { ...lotus, id: "en" };
    const fetchImpl = vi.fn(async (u: string | URL | Request) => new Response(JSON.stringify(String(u).includes("/lea/232/en") ? en : ja))) as unknown as typeof fetch;
    await lookupPrice({ id: 1n, scryfallId: "ja", condition: "NM" }, null, new Scryfall({ fetchImpl }));
    const rows = await getDbForTest().select().from(marketPrices);
    expect(rows.map((r) => r.scryfallId)).toEqual(["en"]);
  });
});

describe("appraisal ENS write calldata (ENSv2 PermissionedResolver)", () => {
  const label = "black-lotus-lea-1";
  const node = namehash(`${label}.kura.eth`);

  it("addresses the card name by its DNS encoding, checked against the indexed node", () => {
    expect(appraisalDnsName(label, node, "kura")).toBe(dnsEncodeName("black-lotus-lea-1.kura.eth"));
    expect(() => appraisalDnsName(label, namehash("other.kura.eth"), "kura")).toThrow(/node/);
  });

  it("sets appraisal.usd and appraisal.at by name, for one multicall", () => {
    const dns = dnsEncodeName(`${label}.kura.eth`);
    const calls = appraisalTextCalls(dns, "192.00", 1_700_000_000);
    expect(calls.map((data) => decodeFunctionData({ abi: abi.ensResolver, data }))).toEqual([
      { functionName: "setText", args: [dns, "appraisal.usd", "192.00"] },
      { functionName: "setText", args: [dns, "appraisal.at", "1700000000"] },
    ]);
  });
});
