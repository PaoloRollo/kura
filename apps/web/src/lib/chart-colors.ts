// Chart colours from the analytics screens (LqnA2, Y1eNn, WABQw): the series tokens and the alpha steps the bars use.
// Kura is dark only. Never use shu or kin as series colours: shu is the CTA/live accent, kin the redeem/whole accent.
import { money } from "@/lib/format";

export const SERIES = {
  s1: "var(--kura-s1)",
  s2: "var(--kura-s2)",
  s3: "var(--kura-s3)",
  s4: "var(--kura-s4)",
  s5: "var(--kura-s5)",
  s7: "var(--kura-s7)",
} as const;

/** 8-digit hex alpha steps, as the designs write them. */
export const ALPHA = {
  /** Price bars during the auction. */
  s1_67: "#3987E5AA",
  /** Demand rows other than the clearing one. */
  s1_50: "#3987E580",
  /** Daily volume bars before the latest bucket. */
  s1_44: "#3987E570",
  /** Price bars after settle, flat at the final clearing. */
  s1_25: "#3987E540",
  /** Holder bars before the latest point. */
  s3_50: "#199E7080",
} as const;

/** Fill order for the "By language" share bars. */
export const SHARE_COLORS = [SERIES.s1, SERIES.s2, SERIES.s3, SERIES.s4] as const;

/** Premium above which a treemap tile is at full strength (±25%). */
export const PREMIUM_FULL = 0.25;
/** Premiums smaller than this (0.5%) read as neutral. */
export const PREMIUM_NEUTRAL = 0.005;

/**
 * Treemap tile fill for a premium (a fraction, 0.096 = +9.6%): s1 mixed into surface-2 for a premium, s2 for a discount,
 * at min(|p| / 25%, 1) x 55%. Neutral (|p| < 0.5%, or no premium) is surface-2.
 */
export function premiumFill(p: number | null): string {
  if (p == null || !Number.isFinite(p) || Math.abs(p) < PREMIUM_NEUTRAL) return "var(--kura-surface-2)";
  const t = Math.round(Math.min(Math.abs(p) / PREMIUM_FULL, 1) * 55 * 10) / 10;
  return `color-mix(in srgb, ${p > 0 ? SERIES.s1 : SERIES.s2} ${t}%, var(--kura-surface-2))`;
}

/** Text tone class for a premium: + s1-fg, − s2-fg, neutral muted. */
export function premiumTone(p: number | null): "text-s1-fg" | "text-s2-fg" | "text-muted-foreground" {
  if (p == null || !Number.isFinite(p) || Math.abs(p) < PREMIUM_NEUTRAL) return "text-muted-foreground";
  return p > 0 ? "text-s1-fg" : "text-s2-fg";
}

/** A premium as the designs print it: "+9.6%", "-18.5%", "0%", "n/a". */
export function premiumLabel(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return "n/a";
  if (Math.abs(p) < PREMIUM_NEUTRAL) return "0%";
  const v = (p * 100).toFixed(1).replace(/\.0$/, "");
  return p > 0 ? `+${v}%` : `${v}%`;
}

/** Plain-number USD (from `Number(formatUnits(x, 6))`) through `money()`: "$1,712.00", "$0.22". */
export function usd(v: number, dp = 2): string {
  return money(BigInt(Math.round(v * 1e6)), dp);
}

/** Compact USD for bar labels: "$4.2k", "$27k", "$1.2M", "$640". */
export function usdCompact(v: number): string {
  const a = Math.abs(v);
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  if (a >= 1e6) return `$${trim(v / 1e6)}M`;
  if (a >= 1e3) return `$${trim(v / 1e3)}k`;
  return usd(v);
}

/** "14:02", 24-hour, in UTC (unix seconds), so server and client render the same label. */
export function hhmm(t: number): string {
  return new Date(t * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

/** Weekday of a "YYYY-MM-DD" UTC bucket: "Mon", or "M" when `narrow`. */
export function weekday(date: string, narrow = false): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: narrow ? "narrow" : "short", timeZone: "UTC" });
}
