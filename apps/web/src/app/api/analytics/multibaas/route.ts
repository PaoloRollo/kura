import { NextResponse } from "next/server";
import { MultibaasError } from "@kura/shared";
import { parseRange } from "@/lib/analytics-view";
import { jsonError } from "@/lib/http";
import { MbShapeError, toWire } from "@/lib/multibaas/figures";
import { recentToWire } from "@/lib/multibaas/recent";
import { MB_RETENTION_HOURS, cachedMultibaasFigures, cachedMultibaasRecent, isMultibaasRange, multibaasConfig } from "@/lib/multibaas/server";

export const dynamic = "force-dynamic";

/**
 * Public: the analytics dashboard's MultiBaas figures for `?range=24h` (lib/multibaas/figures: raised, fees, mints,
 * volume, amounts as decimal strings). 503 UNCONFIGURED without MULTIBAAS_URL / MULTIBAAS_API_KEY; 503 RANGE_UNSUPPORTED
 * for 7d and all, without calling MultiBaas (its plan keeps only the last MB_RETENTION_HOURS of events); 503
 * UNAVAILABLE when MultiBaas is down, slow (over MULTIBAAS_BUDGET_MS in all), on another chain, unlinked, still
 * syncing, linked too recently to cover the window, missing a query, or answers rows of another shape (logged, and
 * reused for FAILURE_TTL_MS). The dashboard then shows the indexer's figures. The API key never leaves the server.
 *
 * `?view=recent`: the newest CardVault events MultiBaas holds (lib/multibaas/recent) and since when it indexes the
 * vault, from the same memoised load as the figures (no MultiBaas call of its own) and without the 24h coverage check.
 * 503 UNCONFIGURED / UNAVAILABLE as above; the dashboard then hides the panel.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const range = parseRange(params.get("range"));
  const cfg = multibaasConfig();
  if (!cfg) return jsonError("UNCONFIGURED", "MultiBaas is not configured", 503);
  if (params.get("view") === "recent") return answer(async () => recentToWire(await cachedMultibaasRecent(cfg)), "recent events are hidden");
  if (!isMultibaasRange(range))
    return jsonError("RANGE_UNSUPPORTED", `MultiBaas keeps the last ${MB_RETENTION_HOURS} h of events; the ${range} range comes from the indexer`, 503);
  return answer(async () => toWire(await cachedMultibaasFigures(cfg, range)), "the dashboard shows the indexer's figures");
}

async function answer(body: () => Promise<unknown>, fallback: string) {
  try {
    return NextResponse.json(await body(), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof MultibaasError || e instanceof MbShapeError) {
      console.warn(`analytics: MultiBaas unavailable, ${fallback} (${e.message})`);
      return jsonError("UNAVAILABLE", "MultiBaas is unavailable", 503);
    }
    console.error("analytics: MultiBaas answer failed", e);
    return jsonError("INTERNAL", "unexpected error", 500);
  }
}
