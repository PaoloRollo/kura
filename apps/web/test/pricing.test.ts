import { describe, expect, it, vi } from "vitest";
import {
  CONDITION_MULTIPLIERS,
  applyMultiplier,
  finishFromDescription,
  finishPrice,
  marketPerShard,
  priceSourceLabel,
  quoteMarketPrice,
  quoteUsdc,
  vsMarket,
  type PrintingPrices,
} from "@/lib/pricing";

const printing = (over: Partial<PrintingPrices> & { prices: PrintingPrices["prices"] }): PrintingPrices => ({
  id: "own", lang: "en", set: "lea", collector_number: "232", ...over,
});
const noEnglish = vi.fn(async () => null);

describe("finish", () => {
  it("reads the finish from the mint description", () => {
    expect(finishFromDescription("Black Lotus, Limited Edition Alpha")).toBe("nonfoil");
    expect(finishFromDescription("Black Lotus, Vintage Masters, foil")).toBe("foil");
    expect(finishFromDescription("Sol Ring, Commander Legends, etched")).toBe("etched");
    expect(finishFromDescription(null)).toBe("nonfoil");
  });

  it("picks the finish's own price and never falls back across finishes", () => {
    const p = { usd: "10.00", usd_foil: null, usd_etched: "30.00" };
    expect(finishPrice(p, "nonfoil")).toBe("10.00");
    expect(finishPrice(p, "foil")).toBeNull();
    expect(finishPrice(p, "etched")).toBe("30.00");
    expect(finishPrice({ usd: null, usd_foil: "20.00" }, "nonfoil")).toBeNull();
  });
});

describe("condition", () => {
  it("has one multiplier per condition", () => {
    expect(CONDITION_MULTIPLIERS).toEqual({ NM: 1.0, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.3 });
  });

  it("applies the multiplier, truncated to cents", () => {
    expect(applyMultiplier("25000.00", 0.85)).toBe("21250");
    expect(applyMultiplier("10.99", 0.7)).toBe("7.69");
    expect(applyMultiplier("1.00", 1)).toBe("1");
  });
});

describe("quoteMarketPrice", () => {
  it("prices the exact printing for its finish and condition", async () => {
    const q = await quoteMarketPrice({ printing: printing({ prices: { usd: "25000.00", usd_foil: "40000.00" } }), finish: "foil", condition: "LP", englishPrinting: noEnglish });
    expect(q).toEqual({ usd: "40000.00", source: { finish: "foil", lang: "en", printingId: "own", englishFallback: false }, conditionMultiplier: 0.85, adjustedUsd: "34000" });
    expect(priceSourceLabel(q, "LP")).toBe("Scryfall USD · foil · EN printing · LP ×0.85");
    expect(quoteUsdc(q)).toBe(34_000_000_000n);
  });

  it("falls back to the English printing with the same set and number", async () => {
    const english = vi.fn(async (set: string, number: string) => printing({ id: "en-id", set, collector_number: number, prices: { usd: "900.00" } }));
    const q = await quoteMarketPrice({ printing: printing({ lang: "ja", set: "4ed", collector_number: "12", prices: { usd: null } }), finish: "nonfoil", condition: "NM", englishPrinting: english });
    expect(english).toHaveBeenCalledWith("4ed", "12");
    expect(q.usd).toBe("900.00");
    expect(q.source).toEqual({ finish: "nonfoil", lang: "en", printingId: "en-id", englishFallback: true });
    expect(priceSourceLabel(q, "NM")).toBe("Scryfall USD · nonfoil · English printing · NM ×1.00");
  });

  it("keeps the finish in the fallback and reports no price when neither has one", async () => {
    const english = vi.fn(async () => printing({ id: "en-id", prices: { usd: "900.00", usd_foil: null } }));
    const q = await quoteMarketPrice({ printing: printing({ lang: "ja", prices: { usd: "5.00" } }), finish: "foil", condition: "HP", englishPrinting: english });
    expect(q.usd).toBeNull();
    expect(q.adjustedUsd).toBeNull();
    expect(q.source.printingId).toBeNull();
    expect(quoteUsdc(q)).toBeNull();
  });

  it("does not look up an English printing for an English card", async () => {
    const english = vi.fn(async () => null);
    const q = await quoteMarketPrice({ printing: printing({ prices: { usd: null } }), finish: "nonfoil", condition: "NM", englishPrinting: english });
    expect(english).not.toHaveBeenCalled();
    expect(q.usd).toBeNull();
  });
});

describe("per shard", () => {
  it("divides the market price by the shard count and compares clearing to it", () => {
    expect(marketPerShard(25_000_000_000n, 16)).toBe(1_562_500_000n);
    expect(vsMarket(1_712_000_000n, 25_000_000_000n, 16)).toBeCloseTo(0.0956, 3);
    expect(vsMarket(null, 25_000_000_000n, 16)).toBeNull();
    expect(vsMarket(1n, null, 16)).toBeNull();
  });
});
