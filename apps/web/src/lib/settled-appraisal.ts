import "server-only";
import { defaultDeps, lookupPrice, publishAppraisalRecord, type Deps, type PublishOutcome } from "@/lib/appraise";
import { Scryfall } from "@/lib/scryfall";
import { MIN_SIGNER_BALANCE_WEI } from "@/lib/signer-floor";

/** Each Scryfall request made for a webhook appraisal gives up after this; the lookup then uses the cached price. */
export const PRICE_LOOKUP_TIMEOUT_MS = 4_000;

/** `fetchImpl` with every request aborted after `ms` (the Scryfall client reports that as unavailable). */
export function fetchWithTimeout(ms: number, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(ms) });
}

// Its own client (the shared one has no timeout): the webhook appraises at most a few cards per POST, so its requests
// sit outside the shared client's spacing without pressing Scryfall's rate limit.
let timedScryfall: Scryfall | null = null;
const webhookScryfall = () => (timedScryfall ??= new Scryfall({ fetchImpl: fetchWithTimeout(PRICE_LOOKUP_TIMEOUT_MS) }));

/** lib/appraise's defaultDeps with the price looked up under PRICE_LOOKUP_TIMEOUT_MS per Scryfall request. */
export const settledAppraisalDeps: Deps = { ...defaultDeps, price: (card, description) => lookupPrice(card, description, webhookScryfall()) };

export type SettledAppraisalOutcome = PublishOutcome | "no-card" | "not-sharded" | "no-name" | "no-price" | "low-funds";

/**
 * Publishes a just-settled card's ENS appraisal (appraisal.usd / appraisal.at) now instead of at the next daily cron,
 * with the value and the write path the cron and buyouts use: the whole card's market price (deps.price, lib/appraise's
 * lookupPrice, cached fallback included) through publishAppraisalRecord (write queue, advisory lock, claim row in
 * ens_appraisal_writes, stuck check, rewrite only on a change or after an hour). Skipped with APPRAISER_WRITE_ENS off,
 * below the cron's signer floor (MIN_SIGNER_BALANCE_WEI, buyouts keep the headroom), and for a card that is gone, whole
 * again, unnamed or unpriced. A card still "auctioning" is fine: the webhook can beat the indexer to the settle, and the
 * cron appraises auctioning cards too. A failing read throws, so the webhook answers 503 and MultiBaas redelivers.
 * Scryfall requests time out after PRICE_LOOKUP_TIMEOUT_MS (settledAppraisalDeps), falling back to the cached price.
 */
export async function publishSettledAppraisal(cardId: bigint, deps: Deps = settledAppraisalDeps): Promise<SettledAppraisalOutcome> {
  if (!deps.ensWritesEnabled()) return "disabled";
  const card = await deps.loadCard(cardId);
  if (!card) return "no-card";
  if (card.state !== "sharded" && card.state !== "auctioning") return "not-sharded";
  const node = await deps.loadEnsNode(cardId);
  if (!node) return "no-name";
  if ((await deps.signerBalance()) < MIN_SIGNER_BALANCE_WEI) return "low-funds";
  const description = await deps.loadEnsText(node, "description");
  const { quote } = await deps.price(card, description);
  if (!quote?.adjustedUsd || Number(quote.adjustedUsd) <= 0) return "no-price";
  return publishAppraisalRecord(cardId, node, quote.adjustedUsd, deps);
}
