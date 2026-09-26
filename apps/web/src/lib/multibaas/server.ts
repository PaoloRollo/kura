import "server-only";
import { MB, MB_QUERIES, MultibaasError, mbQueryRows, mbRequest, type MbConfig, type MbFetch } from "@kura/shared";
import { rangeWindow, type AnalyticsRange } from "@/lib/analytics-view";
import { deployments } from "@/lib/deployments";
import { MbShapeError, figuresFromRows, type MultibaasFigures } from "@/lib/multibaas/figures";

/**
 * The MultiBaas deployment and its API key (server env only), or null when either is unset or the URL is not https:
 * the dashboard then reads the indexer alone. Deliberately outside env.ts's ServerSchema, which fails every
 * authenticated route when any variable is missing.
 */
export function multibaasConfig(env: Record<string, string | undefined> = process.env): MbConfig | null {
  const url = env.MULTIBAAS_URL?.trim();
  const apiKey = env.MULTIBAAS_API_KEY?.trim();
  if (!url || !apiKey) return null;
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { url: url.replace(/\/+$/, ""), apiKey };
}

/** Blocks MultiBaas's CardVault index may trail the chain head before its figures count as stale (about 1 h). */
export const MAX_SYNC_LAG_BLOCKS = 300;

/**
 * What the MultiBaas plan keeps (GET /api/v0/plan on the deployment): event logs for event_logging_retention_hours = 72,
 * past logs only past_logs_max_depth = 100 blocks back from when a contract is linked, event_query_max_results = 50
 * (MB_PAGE). So MultiBaas holds at most the last 72 h of CardVault events, from when the vault was linked: it can answer
 * the 24h range and nothing longer. 7d and all stay on the indexer, and the all-time `add` totals (kura_raised_total,
 * kura_fees_total) are not read: they would sum only what MultiBaas still retains.
 */
export const MB_RETENTION_HOURS = 72;
export type MultibaasRange = "24h";
export const isMultibaasRange = (r: AnalyticsRange): r is MultibaasRange => r === "24h";

/** Sepolia's slot time. Missed slots only make blocks rarer, so blocks × 12 s never overstates the time covered. */
export const BLOCK_SEC = 12;

/**
 * The whole load's time budget. Each request is capped at MB_TIMEOUT_MS (4 s), but a saved query with more than
 * MB_PAGE (50) rows takes several sequential requests, so without an overall cap a large vault could keep the route
 * busy for 4 s per page. At the budget every request still in flight is aborted and the route answers 503, well
 * inside the dashboard's 6 s client cap.
 */
export const MULTIBAAS_BUDGET_MS = 4_500;

type IndexingStatus = { isProcessingPastLogs: boolean; latestBlockNumber: number; startBlockNumber: number };
type ChainStatus = { chainID: number; blockNumber: number };

const blockNumber = (v: unknown, field: string): number => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  throw new MbShapeError(`${field}: expected a block number, got ${typeof v}`);
};

async function load(cfg: MbConfig, range: MultibaasRange, now: number, f: MbFetch): Promise<MultibaasFigures> {
  const opts = { fetch: f };
  const statusPath = `/chains/ethereum/addresses/${MB.addressAlias}/contracts/${MB.contractLabel}/status`;
  const [chain, status, settles, redeems, mints, fees] = await Promise.all([
    mbRequest<ChainStatus>(cfg, "GET", "/chains/ethereum/status", opts),
    // Live, while the kura_vault alias doesn't exist this answers 400 "invalid address", not 404.
    mbRequest<IndexingStatus>(cfg, "GET", statusPath, opts).catch((e: unknown) => {
      if (e instanceof MultibaasError && e.status === 400) return null;
      throw e;
    }),
    mbQueryRows(cfg, MB_QUERIES.settles, opts),
    mbQueryRows(cfg, MB_QUERIES.redeems, opts),
    mbQueryRows(cfg, MB_QUERIES.mints, opts),
    mbQueryRows(cfg, MB_QUERIES.fees, opts),
  ]);
  if (!chain) throw new MultibaasError(404, "MultiBaas answered no chain status");
  const vault = deployments();
  if (chain.chainID !== vault.chainId) throw new MultibaasError(null, `MultiBaas is on chain ${String(chain.chainID)}, the vault on ${vault.chainId}`);
  if (!status) throw new MultibaasError(404, "the CardVault is not linked in MultiBaas (run scripts/multibaas-setup.ts --apply)");
  if (status.isProcessingPastLogs) throw new MultibaasError(503, "MultiBaas is still syncing past CardVault events");
  const head = blockNumber(chain.blockNumber, "blockNumber");
  const lag = head - blockNumber(status.latestBlockNumber, "latestBlockNumber");
  if (lag > MAX_SYNC_LAG_BLOCKS) throw new MultibaasError(503, `MultiBaas's CardVault index is ${lag} blocks behind the chain`);
  // The linked contract's own history must reach back over the whole window (or to the vault's deployment): linked
  // with a recent startingBlock, MultiBaas holds nothing before it, and the window's figures would read as too low.
  const start = blockNumber(status.startBlockNumber, "startBlockNumber");
  const need = Math.ceil((now - rangeWindow(range, now, null).from) / BLOCK_SEC);
  if (start > vault.deployBlock && head - start < need)
    throw new MultibaasError(503, `MultiBaas has indexed the CardVault since block ${start}, not the whole ${range} window (${need} blocks)`);
  return figuresFromRows({ settles, redeems, mints, fees, raisedTotal: [], feesTotal: [] }, range, now);
}

/**
 * The dashboard's 24h MultiBaas figures: the chain head and the vault's indexing status, then the four list Event Queries,
 * all in parallel (each request capped at MB_TIMEOUT_MS, the whole load at `budgetMs`). Throws MultibaasError when
 * MultiBaas is down, slow, on another chain, the vault is not linked, still syncing past logs, over MAX_SYNC_LAG_BLOCKS
 * behind or linked too recently to cover the window, or a query is missing; MbShapeError when a row isn't what the queries select. On any
 * failure the requests still in flight (other queries' later pages) are aborted.
 */
export async function loadMultibaasFigures(
  cfg: MbConfig,
  range: MultibaasRange,
  now: number,
  f?: MbFetch,
  budgetMs: number = MULTIBAAS_BUDGET_MS,
): Promise<MultibaasFigures> {
  const base: MbFetch = f ?? ((url, init) => fetch(url, init));
  const stop = new AbortController();
  const bounded: MbFetch = (url, init) => base(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, stop.signal]) : stop.signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const over = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new MultibaasError(null, `MultiBaas took over ${budgetMs} ms`);
      stop.abort(e);
      reject(e);
    }, budgetMs);
  });
  try {
    return await Promise.race([load(cfg, range, now, bounded), over]);
  } finally {
    clearTimeout(timer);
    stop.abort(); // a failed query leaves the others' later pages in flight; nothing waits for them
  }
}

/** How long one range's answer is reused: every dashboard polls, MultiBaas sees at most one burst per range per 15 s. */
export const FIGURES_TTL_MS = 15_000;
const memo = new Map<MultibaasRange, { at: number; value: Promise<MultibaasFigures> }>();

export function resetMultibaasMemo() {
  memo.clear();
}

/** loadMultibaasFigures memoised per range for FIGURES_TTL_MS, concurrent callers sharing one load; failures are dropped. */
export function cachedMultibaasFigures(cfg: MbConfig, range: MultibaasRange, nowMs = Date.now()): Promise<MultibaasFigures> {
  const hit = memo.get(range);
  if (hit && nowMs - hit.at < FIGURES_TTL_MS) return hit.value;
  const value = loadMultibaasFigures(cfg, range, Math.floor(nowMs / 1000));
  memo.set(range, { at: nowMs, value });
  value.catch(() => {
    if (memo.get(range)?.value === value) memo.delete(range);
  });
  return value;
}
