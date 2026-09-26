import "server-only";
import { MB, MB_QUERIES, MultibaasError, mbQueryRows, mbRequest, type MbConfig, type MbFetch } from "@kura/shared";
import { rangeWindow, type AnalyticsRange } from "@/lib/analytics-view";
import { deployments } from "@/lib/deployments";
import { MbShapeError, figuresFromRows, type MultibaasFigures } from "@/lib/multibaas/figures";
import { recentFromRows, type MultibaasRecent, type RecentRows } from "@/lib/multibaas/recent";

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

/**
 * The linked contract's indexing status. Its `latestBlockNumber` is not read: live, it stays at the link-time block
 * while the contract emits nothing, so a head-minus-latest lag would call a quiet, healthy vault stale (plan U6).
 */
type IndexingStatus = { isProcessingPastLogs: boolean; startBlockNumber: number };
type ChainStatus = { chainID: number; blockNumber: number };

const blockNumber = (v: unknown, field: string): number => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  throw new MbShapeError(`${field}: expected a block number, got ${typeof v}`);
};

/**
 * What one load reads from MultiBaas, shared by the 24h figures and the recent-events panel: the four list queries'
 * rows, the chain head and the vault's indexing start block, and when it was read (unix seconds).
 */
export type MultibaasSnapshot = { rows: RecentRows; head: number; startBlock: number; loadedAt: number };

/**
 * Two phases, to spend the plan's 30,000 calls a month: the chain status and the vault's indexing status first (2
 * calls), and the four list queries only once those pass. A guard failure costs 2 calls, not 6, and its reason is the
 * one logged, not a query's 404 that happened to lose the race. The 24h coverage check is not a guard here: the
 * recent-events panel shows whatever MultiBaas holds, so it is applied per view (multibaasFiguresOf).
 */
async function load(cfg: MbConfig, now: number, f: MbFetch): Promise<MultibaasSnapshot> {
  const opts = { fetch: f };
  const statusPath = `/chains/ethereum/addresses/${MB.addressAlias}/contracts/${MB.contractLabel}/status`;
  const [chain, status] = await Promise.all([
    mbRequest<ChainStatus>(cfg, "GET", "/chains/ethereum/status", opts),
    // Live, while the kura_vault alias doesn't exist this answers 400 "invalid address", not 404.
    mbRequest<IndexingStatus>(cfg, "GET", statusPath, opts).catch((e: unknown) => {
      if (e instanceof MultibaasError && e.status === 400) return null;
      throw e;
    }),
  ]);
  if (!chain) throw new MultibaasError(404, "MultiBaas answered no chain status");
  const vault = deployments();
  if (chain.chainID !== vault.chainId) throw new MultibaasError(null, `MultiBaas is on chain ${String(chain.chainID)}, the vault on ${vault.chainId}`);
  if (!status) throw new MultibaasError(404, "the CardVault is not linked in MultiBaas (run scripts/multibaas-setup.ts --apply)");
  if (status.isProcessingPastLogs) throw new MultibaasError(503, "MultiBaas is still syncing past CardVault events");
  const head = blockNumber(chain.blockNumber, "blockNumber");
  const startBlock = blockNumber(status.startBlockNumber, "startBlockNumber");
  const [settles, redeems, mints, fees] = await Promise.all([
    mbQueryRows(cfg, MB_QUERIES.settles, opts),
    mbQueryRows(cfg, MB_QUERIES.redeems, opts),
    mbQueryRows(cfg, MB_QUERIES.mints, opts),
    mbQueryRows(cfg, MB_QUERIES.fees, opts),
  ]);
  return { rows: { settles, redeems, mints, fees }, head, startBlock, loadedAt: now };
}

/**
 * The 24h figures from a snapshot, once MultiBaas's copy of the vault reaches back over the whole window (or to the
 * vault's deployment): linked with a recent startingBlock, MultiBaas holds nothing before it, and the window's figures
 * would read as too low. Throws MultibaasError until then (the first ~24 h after linking), MbShapeError on a bad row.
 */
export function multibaasFiguresOf(s: MultibaasSnapshot, range: MultibaasRange, now: number): MultibaasFigures {
  const need = Math.ceil((now - rangeWindow(range, now, null).from) / BLOCK_SEC);
  if (s.startBlock > deployments().deployBlock && s.head - s.startBlock < need)
    throw new MultibaasError(503, `MultiBaas has indexed the CardVault since block ${s.startBlock}, not the whole ${range} window (${need} blocks)`);
  return figuresFromRows({ ...s.rows, raisedTotal: [], feesTotal: [] }, range, now);
}

/** The recent-events panel from a snapshot: whatever MultiBaas holds, newest first, and since when. No coverage check. */
export function multibaasRecentOf(s: MultibaasSnapshot): MultibaasRecent {
  const since = s.loadedAt - Math.max(0, s.head - s.startBlock) * BLOCK_SEC;
  return recentFromRows(s.rows, { startBlock: s.startBlock, since, fromDeploy: s.startBlock <= deployments().deployBlock });
}

/**
 * One load: the chain head and the vault's indexing status, then (only if those pass) the four list Event Queries
 * (each request capped at MB_TIMEOUT_MS, the whole load at `budgetMs`). Throws MultibaasError when MultiBaas is down,
 * slow, on another chain, the vault is not linked or still syncing past logs, or a query is missing. On any failure
 * the requests still in flight (other queries' later pages) are aborted.
 */
export async function loadMultibaasSnapshot(cfg: MbConfig, now: number, f?: MbFetch, budgetMs: number = MULTIBAAS_BUDGET_MS): Promise<MultibaasSnapshot> {
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
    return await Promise.race([load(cfg, now, bounded), over]);
  } finally {
    clearTimeout(timer);
    stop.abort(); // a failed query leaves the others' later pages in flight; nothing waits for them
  }
}

/** loadMultibaasSnapshot then multibaasFiguresOf, unmemoised. */
export async function loadMultibaasFigures(
  cfg: MbConfig,
  range: MultibaasRange,
  now: number,
  f?: MbFetch,
  budgetMs: number = MULTIBAAS_BUDGET_MS,
): Promise<MultibaasFigures> {
  return multibaasFiguresOf(await loadMultibaasSnapshot(cfg, now, f, budgetMs), range, now);
}

/**
 * How long a good snapshot is reused, counted from when its load resolved. The plan allows 30,000 calls a month (about
 * 1,000 a day) and a load costs 6+: at one load per 10 min that is about 870 a day however many tabs poll, for the
 * figures and the recent-events panel together. Vault events reset it sooner through invalidateMultibaasFigures (the
 * MultiBaas webhook).
 */
export const FIGURES_TTL_MS = 10 * 60_000;
/**
 * How long a failed load is reused (the route still answers 503, logging the same cause): as long as a good one, since
 * a failure (an unlinked vault) can last days. 2 calls per 10 min, about 290 a day. The 24h coverage check is not a
 * load failure: during the first day after linking the snapshot loads (6 calls) for the recent panel, and only the
 * figures answer 503.
 */
export const FAILURE_TTL_MS = FIGURES_TTL_MS;

type Entry = { value: Promise<MultibaasSnapshot>; settled: null | { at: number; ok: boolean } };
/** One entry: the figures and the recent-events panel read the same snapshot, so the panel costs no extra call. */
let memo: Entry | null = null;
let generation = 0;

/**
 * Drops the memoised snapshot, good or failed, so the next request loads afresh: for the webhook route, when MultiBaas
 * reports a new CardVault event. A load already in flight still answers its callers but is not kept.
 */
export function invalidateMultibaasFigures() {
  generation += 1;
  memo = null;
}

/**
 * loadMultibaasSnapshot memoised: concurrent callers share one load; a good snapshot is reused for FIGURES_TTL_MS and
 * a failure (its error rethrown, so the route logs the cause) for FAILURE_TTL_MS, both counted from when it settled.
 */
function cachedSnapshot(cfg: MbConfig): Promise<MultibaasSnapshot> {
  const nowMs = Date.now();
  const hit = memo;
  if (hit && (!hit.settled || nowMs - hit.settled.at < (hit.settled.ok ? FIGURES_TTL_MS : FAILURE_TTL_MS))) return hit.value;
  const gen = generation;
  const value = loadMultibaasSnapshot(cfg, Math.floor(nowMs / 1000));
  const entry: Entry = { value, settled: null };
  memo = entry;
  const settle = (ok: boolean) => {
    if (gen === generation && memo === entry) entry.settled = { at: Date.now(), ok };
  };
  value.then(
    () => settle(true),
    () => settle(false),
  );
  return value;
}

/** The 24h figures from the memoised snapshot, the coverage check applied at the request's time. */
export async function cachedMultibaasFigures(cfg: MbConfig, range: MultibaasRange): Promise<MultibaasFigures> {
  const s = await cachedSnapshot(cfg);
  return multibaasFiguresOf(s, range, Math.floor(Date.now() / 1000));
}

/** The recent-events panel from the same memoised snapshot (no MultiBaas call of its own). */
export async function cachedMultibaasRecent(cfg: MbConfig): Promise<MultibaasRecent> {
  return multibaasRecentOf(await cachedSnapshot(cfg));
}
