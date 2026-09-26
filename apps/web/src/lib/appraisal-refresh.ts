// How often a tab may ask /api/appraise for a fresh signed appraisal: at most once per MIN_APPRAISAL_INTERVAL_MS, and
// after failures with an exponential backoff, so an erroring server never sees a request storm.

export const MIN_APPRAISAL_INTERVAL_MS = 10_000;
export const MAX_APPRAISAL_BACKOFF_MS = 5 * 60_000;
/** Re-fetch once the quote has less than this left, so the signature never expires mid-flow. */
export const REFRESH_BEFORE_SEC = 30;

/** Wait after `failures` consecutive failures before trying again: 10 s, 20 s, 40 s… capped at 5 min. */
export function retryDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(MIN_APPRAISAL_INTERVAL_MS * 2 ** (failures - 1), MAX_APPRAISAL_BACKOFF_MS);
}

// Per tab (module state): the last request's start and the failures since the last success.
let lastRequestAt = Number.NEGATIVE_INFINITY;
let lastErrorAt = Number.NEGATIVE_INFINITY;
let failures = 0;

export function resetAppraisalThrottleForTests() {
  lastRequestAt = Number.NEGATIVE_INFINITY;
  lastErrorAt = Number.NEGATIVE_INFINITY;
  failures = 0;
}

/** True when a new attempt may start now: the interval since the last request and the backoff after the last failure. */
export function canAttemptAppraisal(nowMs: number): boolean {
  return nowMs - lastRequestAt >= MIN_APPRAISAL_INTERVAL_MS && nowMs - lastErrorAt >= retryDelayMs(failures);
}

/**
 * Runs one appraisal request, and records success or failure. Within the per-tab interval it answers with `reuse()`
 * (the cached quote, while it is still good: a blanket cache invalidation after a transaction must not re-sign) and
 * otherwise waits the interval out before asking.
 */
export async function throttledAppraisal<T>(
  fn: () => Promise<T>,
  reuse: () => T | undefined = () => undefined,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  const wait = lastRequestAt + MIN_APPRAISAL_INTERVAL_MS - Date.now();
  if (wait > 0) {
    const cached = reuse();
    if (cached !== undefined) return cached;
    await sleep(wait);
  }
  lastRequestAt = Date.now();
  try {
    const out = await fn();
    failures = 0;
    return out;
  } catch (e) {
    failures += 1;
    lastErrorAt = Date.now();
    throw e;
  }
}
