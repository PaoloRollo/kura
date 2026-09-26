import "server-only";
import { defaultDeps, publishAppraisalRecord, type Deps, type PublishOutcome } from "@/lib/appraise";
import { MIN_SIGNER_BALANCE_WEI } from "@/lib/signer-floor";

export type SettledAppraisalOutcome = PublishOutcome | "no-card" | "not-sharded" | "no-name" | "no-price" | "low-funds";

/**
 * Publishes a just-settled card's ENS appraisal (appraisal.usd / appraisal.at) now instead of at the next daily cron,
 * with the value and the write path the cron and buyouts use: the whole card's market price (deps.price, lib/appraise's
 * lookupPrice, cached fallback included) through publishAppraisalRecord (write queue, advisory lock, claim row in
 * ens_appraisal_writes, stuck check, rewrite only on a change or after an hour). Skipped with APPRAISER_WRITE_ENS off,
 * below the cron's signer floor (MIN_SIGNER_BALANCE_WEI, buyouts keep the headroom), and for a card that is gone, whole
 * again, unnamed or unpriced. A card still "auctioning" is fine: the webhook can beat the indexer to the settle, and the
 * cron appraises auctioning cards too. A failing read throws, so the webhook answers 503 and MultiBaas redelivers.
 */
export async function publishSettledAppraisal(cardId: bigint, deps: Deps = defaultDeps): Promise<SettledAppraisalOutcome> {
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
