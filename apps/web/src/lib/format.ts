import { formatUnits } from "viem";

/** USDC (6 decimals): at least two decimals, more only when they carry value ("12.50", "0.000005"). */
export function usdc(x: bigint): string {
  const s = formatUnits(x, 6);
  const [i, f = ""] = s.split(".");
  if (f.length <= 2) return `${i}.${f.padEnd(2, "0")}`;
  return `${i}.${f.replace(/0+$/, "")}`;
}

/** Shards (18 decimals), truncated to at most 4 decimals with trailing zeros dropped ("2.5", "1"). */
export function shards(x: bigint): string {
  const s = formatUnits(x, 18);
  const [i, f = ""] = s.split(".");
  const trimmed = f.slice(0, 4).replace(/0+$/, "");
  return trimmed ? `${i}.${trimmed}` : i;
}

/** Truncates a decimal string to `dp` places and groups the integer part (en-US). */
function fixed(s: string, dp: number): string {
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  const grouped = BigInt(i).toLocaleString("en-US");
  const frac = dp > 0 ? `.${f.slice(0, dp).padEnd(dp, "0")}` : "";
  return `${neg ? "-" : ""}${grouped}${frac}`;
}

/**
 * USDC as money, always with at least two decimals so small amounts never read "$0": "$1,712.00", "$0.22".
 * `dp` can add decimals, never remove them. Truncates, never rounds up.
 */
export function money(x: bigint, dp = 2): string {
  const v = fixed(formatUnits(x, 6), Math.max(2, dp));
  return v.startsWith("-") ? `-$${v.slice(1)}` : `$${v}`;
}


/** Shards with a fixed number of decimals, the way the designs show them: "13.0", "0.5". */
export function shardsFixed(x: bigint, dp = 1): string {
  return fixed(formatUnits(x, 18), dp);
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The short hash the transaction rows show: "0x3a1…9f2". */
export const shortHash = (h: string) => `${h.slice(0, 5)}…${h.slice(-3)}`;

const SECONDS_PER_BLOCK = 12;

export function blocksToMinutes(n: bigint): string {
  const mins = (Number(n) * SECONDS_PER_BLOCK) / 60;
  return mins < 1 ? "under a minute" : `${Math.round(mins)} min`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Time left at 12 s per block: "04:12" under an hour, "1:12:30" under a day, else "6d 4h". */
export function countdown(blocksLeft: bigint): string {
  return countdownSeconds(Number(blocksLeft) * SECONDS_PER_BLOCK);
}

/** Seconds a block count spans at 12 s per block. */
export const blocksToSeconds = (n: bigint) => Number(n) * SECONDS_PER_BLOCK;

/** The countdown format for a number of seconds (negative reads as zero). */
export function countdownSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}
