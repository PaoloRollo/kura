import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { APPRAISAL_TYPES, cardVaultDomain, usdcPerShardToQ96 } from "@kura/shared";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/migrate";
import { appraisals } from "@/lib/db/schema";
import { deployments, resetDeploymentsForTests, setDeploymentsForTests } from "@/lib/deployments";
import { computeUsdcPerShard, lookupPrice, resolveFinish, runAppraise, type Deps, type PriceLookup } from "@/lib/appraise";
import type { PriceQuote } from "@/lib/pricing";
import { signerAddress } from "@/lib/signer";
import { Scryfall } from "@/lib/scryfall";
import type { AnyDb } from "@/lib/db/client";

const KEY = ("0x" + "a1".repeat(32)) as Hex;
const shardToken = "0x3333333333333333333333333333333333333333" as const;
const card = { id: 1n, scryfallId: "x", condition: "NM", shardToken, state: "sharded" };
const sharding = { shardToken, cardId: 1n, totalShards: 16, settled: true, redeemer: null, clearingUsdcPerShard: 10_000_000n, clearingPriceQ96: usdcPerShardToQ96(10_000_000n) };

function quote(usd: string | null, m = 1, adjusted = usd): PriceQuote {
  return { usd, source: { finish: "nonfoil", lang: "en", printingId: usd ? "x" : null, englishFallback: false }, conditionMultiplier: m, adjustedUsd: adjusted };
}
const priced = (q: PriceQuote, source: PriceLookup["source"] = "scryfall"): PriceLookup => ({ quote: q, source, pricedAt: 1_700_000_000 });

function deps(over: Partial<Deps> = {}): Deps {
  return {
    loadCard: vi.fn(async () => card),
    loadSharding: vi.fn(async () => sharding),
    loadEnsNode: vi.fn(async () => null),
    loadEnsText: vi.fn(async () => null),
    price: vi.fn(async () => priced(quote("192.00"))),
    writeEnsRecord: vi.fn(async () => undefined),
    ...over,
  };
}

describe("appraise", () => {
  let db: AnyDb;
  beforeEach(async () => {
    db = await createTestDb();
    process.env.SIGNER_PRIVATE_KEY = KEY;
    setDeploymentsForTests({ ...deployments(), signer: privateKeyToAccount(KEY).address });
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
    const d = deps({ loadEnsNode: vi.fn(async () => "0xabc" as Hex), loadEnsText: vi.fn(async () => "Black Lotus, Limited Edition Alpha, foil") });
    await runAppraise({ cardId: "1" }, d);
    expect(d.loadEnsText).toHaveBeenCalledWith("0xabc", "description");
    expect(d.price).toHaveBeenCalledWith(card, "Black Lotus, Limited Edition Alpha, foil");
    expect(d.writeEnsRecord).toHaveBeenCalledWith("0xabc", "192.00");
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

describe("resolveFinish", () => {
  it("prices foil only for a foil mint or a foil-only printing", () => {
    expect(resolveFinish("Black Lotus, Limited Edition Alpha, foil", ["nonfoil", "foil"])).toBe("foil");
    expect(resolveFinish("Sol Ring, Commander Legends, etched", ["etched"])).toBe("etched");
    expect(resolveFinish("Black Lotus, Limited Edition Alpha", ["nonfoil", "foil"])).toBe("nonfoil");
    expect(resolveFinish(null, ["foil"])).toBe("foil");
    expect(resolveFinish(null, ["etched"])).toBe("etched");
    expect(resolveFinish(null, undefined)).toBe("nonfoil");
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

  it("prices live, then falls back to the cached printing while Scryfall is busy", async () => {
    let clock = 1_700_000_000_000;
    let status = 200;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(lotus), { status })) as unknown as typeof fetch;
    const s = new Scryfall({ fetchImpl, now: () => clock });
    const live = await lookupPrice({ scryfallId: "lotus", condition: "NM" }, null, s);
    expect(live.source).toBe("scryfall");
    expect(live.quote?.adjustedUsd).toBe("25400");

    clock += 3 * 24 * 60 * 60 * 1000; // past the cache TTL
    status = 429;
    const cached = await lookupPrice({ scryfallId: "lotus", condition: "LP" }, null, s);
    expect(cached.source).toBe("snapshot");
    expect(cached.pricedAt).toBe(1_700_000_000);
    expect(cached.quote?.adjustedUsd).toBe("21590");

    const unknown = await lookupPrice({ scryfallId: "nope", condition: "NM" }, null, s);
    expect(unknown).toEqual({ quote: null, source: null, pricedAt: null });
  });
});
