// The market price rule, in one place (controller ruling). Pure: the Scryfall lookups are passed in, so the card page
// (through /api/cards/[id]/price), the shard wizard and Task 7's appraisals share one rule and node tests cover it.
import { formatUnits, parseUnits } from "viem";
import type { Condition } from "@kura/shared";

export type Finish = "nonfoil" | "foil" | "etched";

/** Condition multipliers applied to the Scryfall price (Scryfall prices are near-mint). The single config table. */
export const CONDITION_MULTIPLIERS: Record<Condition, number> = { NM: 1.0, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.3 };

/** A printing's Scryfall prices (the API's snake_case keys). */
export type PrintingPrices = {
  id: string;
  lang: string;
  set: string;
  collector_number: string;
  prices: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null };
};

export type PriceQuote = {
  /** Scryfall USD for the finish, before the condition multiplier; null when no printing has a price for it. */
  usd: string | null;
  source: {
    finish: Finish;
    /** The priced printing's language (the card's own printing, or "en" for the English fallback). */
    lang: string;
    /** The Scryfall id of the printing that was priced; null when neither had a price. */
    printingId: string | null;
    /** True when the card's own printing had no price and the English printing (same set and number) was used. */
    englishFallback: boolean;
  };
  conditionMultiplier: number;
  /** usd × conditionMultiplier, 2 decimals; null with usd. */
  adjustedUsd: string | null;
};

/** The card's finish from its mint description ("Black Lotus, Limited Edition Alpha, foil"). */
export function finishFromDescription(description: string | null | undefined): Finish {
  const d = (description ?? "").trim();
  if (/,\s*etched$/i.test(d)) return "etched";
  if (/,\s*foil$/i.test(d)) return "foil";
  return "nonfoil";
}

/**
 * The finish a card is priced at, the one rule for every price (display, shard wizard, appraisal): the finish its mint
 * description names (", foil" / ", etched"); otherwise a printing that has no non-foil finish is priced at the finish it
 * has, foil before etched; everything else is non-foil.
 */
export function finishOf(description: string | null | undefined, printing: { finishes?: readonly string[] | null } | null | undefined): Finish {
  const named = finishFromDescription(description);
  if (named !== "nonfoil") return named;
  const f = printing?.finishes;
  if (f && f.length > 0 && !f.includes("nonfoil")) {
    if (f.includes("foil")) return "foil";
    if (f.includes("etched")) return "etched";
  }
  return "nonfoil";
}

/** The price for exactly this finish; never falls back across finishes. */
export function finishPrice(p: PrintingPrices["prices"], finish: Finish): string | null {
  const v = finish === "foil" ? p.usd_foil : finish === "etched" ? p.usd_etched : p.usd;
  return v ? v : null;
}

export function conditionMultiplier(condition: string): number {
  return CONDITION_MULTIPLIERS[condition as Condition] ?? 1;
}

/** usd × m, truncated to cents. */
export function applyMultiplier(usd: string, m: number): string {
  const micro = parseUnits(usd, 6);
  const bps = BigInt(Math.round(m * 10_000));
  const adjusted = (micro * bps) / 10_000n;
  return formatUnits(adjusted - (adjusted % 10_000n), 6);
}

/**
 * Prices a card: the exact printing's price for its finish; if none, the English printing with the same set and
 * collector number (`englishPrinting`, only asked for a non-English printing); then the condition multiplier.
 */
export async function quoteMarketPrice(p: {
  printing: PrintingPrices;
  finish: Finish;
  condition: string;
  englishPrinting: (set: string, collectorNumber: string) => Promise<PrintingPrices | null>;
}): Promise<PriceQuote> {
  const m = conditionMultiplier(p.condition);
  const quote = (usd: string | null, printing: PrintingPrices | null, englishFallback: boolean): PriceQuote => ({
    usd,
    source: { finish: p.finish, lang: printing?.lang ?? p.printing.lang, printingId: usd ? (printing?.id ?? null) : null, englishFallback },
    conditionMultiplier: m,
    adjustedUsd: usd ? applyMultiplier(usd, m) : null,
  });
  const own = finishPrice(p.printing.prices, p.finish);
  if (own) return quote(own, p.printing, false);
  if (p.printing.lang !== "en") {
    const en = await p.englishPrinting(p.printing.set, p.printing.collector_number).catch(() => null);
    const enPrice = en ? finishPrice(en.prices, p.finish) : null;
    if (en && enPrice) return quote(enPrice, en, true);
  }
  return quote(null, null, false);
}

/** The label shown next to a price: "Scryfall USD · foil · English printing · LP ×0.85". */
export function priceSourceLabel(q: PriceQuote, condition: string): string {
  const printing = q.source.englishFallback ? "English printing" : `${q.source.lang.toUpperCase()} printing`;
  return `Scryfall USD · ${q.source.finish} · ${printing} · ${condition} ×${q.conditionMultiplier.toFixed(2)}`;
}

/** A quote's adjusted price as USDC (6 decimals), or null. */
export function quoteUsdc(q: PriceQuote | null | undefined): bigint | null {
  if (!q?.adjustedUsd) return null;
  const v = parseUnits(q.adjustedUsd, 6);
  return v > 0n ? v : null; // a zero price is "no price", same as the shard wizard
}

/** The market reference per whole shard (the "Market / 16" line). */
export function marketPerShard(market: bigint | null, totalShards: number): bigint | null {
  if (!market || totalShards <= 0) return null;
  return market / BigInt(totalShards);
}

/** Clearing vs market as a fraction (+0.096 = 9.6% above), or null without both prices. */
export function vsMarket(clearingPerShard: bigint | null, market: bigint | null, totalShards: number): number | null {
  const ref = marketPerShard(market, totalShards);
  if (clearingPerShard == null || !ref) return null;
  return Number(((clearingPerShard - ref) * 1_000_000n) / ref) / 1_000_000;
}
