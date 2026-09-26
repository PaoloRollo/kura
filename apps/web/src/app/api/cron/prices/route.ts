import { NextResponse } from "next/server";
import { formatEther, type Hex } from "viem";
import { timingSafeEqual } from "node:crypto";
import { ne } from "@ponder/client";
import { getDb } from "@/lib/db/client";
import { marketPrices } from "@/lib/db/schema";
import { jsonError } from "@/lib/http";
import { ENS_WRITE_TIMEOUT_MS, defaultDeps as appraiseDeps, publishAppraisalRecord } from "@/lib/appraise";
import { marketPriceForCard } from "@/lib/market-price";
import { MIN_SIGNER_BALANCE_WEI } from "@/lib/signer-floor";
import type { PriceQuote } from "@/lib/pricing";
import { ponderServer, schema } from "@/lib/ponder-server";
import { t, type Row } from "@/lib/ponder-bridge";
import { scryfall as sharedScryfall, type ScryfallCard } from "@/lib/scryfall";

type CardRow = Row<typeof schema.cards>;

// Within every Vercel plan's limit; a few dozen cards at Scryfall's ~10 req/s take seconds.
export const maxDuration = 60;
/** Stop starting new cards past this, so the run returns before maxDuration kills it. */
export const BUDGET_MS = 50_000;
/** At most this many ENS appraisal writes per run (one signer, one nonce sequence); the rest wait for the next run. */
export const MAX_ENS_WRITES_PER_RUN = 20;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Daily (vercel.json, 03:00 UTC; Vercel Cron sends `Authorization: Bearer $CRON_SECRET`): today's `market_prices`
 * row for every vault card's printing (cards not released), plus the English printing when that is what the card is
 * priced at (lib/pricing's fallback). One row per printing and UTC day, upserted. Sequential, so Scryfall's rate limit
 * holds; every lookup is `fresh` (past Scryfall's 24h cache), so a snapshot never records yesterday's price.
 *
 * With APPRAISER_WRITE_ENS=true it also publishes each sharded or auctioning card's appraisal on its ENS name
 * (appraisal.usd / appraisal.at) through lib/appraise's buyout path, `publishAppraisalRecord` (write queue, advisory
 * lock with a claim row in ens_appraisal_writes, pending nonce with one fresh-nonce retry, rewrite only on a change or
 * after an hour), with the value a buyout appraisal publishes: the whole card's market price at its finish and
 * condition. Auctioning cards are included on purpose: a market reference while the auction is live. A failed write
 * never fails the snapshot. The writes are capped: MAX_ENS_WRITES_PER_RUN per run, none while the signer holds less than
 * MIN_SIGNER_BALANCE_WEI (buyouts keep the headroom), none started when less than a write's wait is left of the
 * budget, and none after a write timed out, found the signer stuck or ran out of funds; the rest wait for the next run.
 *
 * `{ updated, total, appraised, appraisalErrors }`: printings written, cards considered, ENS records written, writes that
 * failed or didn't confirm in time; `partial: true` when the run stopped at BUDGET_MS or left writes for the next run.
 */
export async function GET(req: Request) {
  const start = Date.now();
  if (!authorized(req)) return jsonError("UNAUTHENTICATED", "bad secret", 401);
  let cards: CardRow[];
  try {
    cards = (await ponderServer().db.select().from(t(schema.cards)).where(ne(t(schema.cards.state), "released"))) as CardRow[];
  } catch (e) {
    console.error("cron prices: indexer unavailable", e);
    return jsonError("UNAVAILABLE", "card data is temporarily unavailable", 503);
  }
  const date = new Date().toISOString().slice(0, 10);
  const s = sharedScryfall();
  const deps = appraiseDeps;
  let ens = deps.ensWritesEnabled();
  if (ens) {
    // Read once: a run is short, and each write costs far less than the floor.
    const balance = await deps.signerBalance().catch((e) => { console.warn("cron prices: could not read the signer balance, no ENS appraisals this run", e); return null; });
    if (balance != null && balance < MIN_SIGNER_BALANCE_WEI) console.warn(`cron prices: the signer holds ${formatEther(balance)} ETH, under ${formatEther(MIN_SIGNER_BALANCE_WEI)}; no ENS appraisals this run (buyouts keep the rest)`);
    ens = balance != null && balance >= MIN_SIGNER_BALANCE_WEI;
  }
  const done = new Set<string>();
  const printings = new Map<string, ScryfallCard | null>();
  const fresh = { fresh: true };
  const fetchPrinting = async (id: string) => {
    if (!printings.has(id)) printings.set(id, await s.getCard(id, fresh));
    return printings.get(id)!;
  };
  const snapshot = async (printing: ScryfallCard | null) => {
    if (!printing || done.has(printing.id)) return;
    const row = { usd: printing.prices.usd ?? null, usdFoil: printing.prices.usd_foil ?? null, usdEtched: printing.prices.usd_etched ?? null, eur: printing.prices.eur ?? null };
    await getDb().insert(marketPrices).values({ scryfallId: printing.id, date, ...row })
      .onConflictDoUpdate({ target: [marketPrices.scryfallId, marketPrices.date], set: row });
    done.add(printing.id);
  };
  let appraised = 0;
  let appraisalErrors = 0;
  let attempts = 0;
  let deferred = 0;
  /** Why this run stopped starting ENS writes, once it did. */
  let halted: string | null = null;
  const result = (partial: boolean) =>
    NextResponse.json({ updated: done.size, total: cards.length, appraised, appraisalErrors, ...(partial ? { partial: true } : {}) });

  for (const [i, card] of cards.entries()) {
    const elapsed = Date.now() - start;
    if (elapsed > BUDGET_MS) {
      console.warn(`cron prices: stopped after ${Math.round(elapsed / 1000)}s at card ${i + 1} of ${cards.length}; the rest wait for the next run`);
      return result(true);
    }
    const appraise = ens && (card.state === "sharded" || card.state === "auctioning");
    let quote: PriceQuote | null = null;
    let node: Hex | null = null;
    let description: string | null | undefined;
    if (appraise) {
      // The appraisal reads the node and the mint description itself, like runAppraise. A failure here only costs the
      // card its appraisal: the snapshot goes on, with marketPriceForCard looking the description up.
      try {
        node = await deps.loadEnsNode(card.id);
        description = node ? await deps.loadEnsText(node, "description") : null;
      } catch (e) {
        console.warn(`cron prices: card ${card.id}'s ENS name could not be read, no appraisal`, e);
        node = null;
        description = undefined;
      }
    }
    try {
      const own = await fetchPrinting(card.scryfallId);
      await snapshot(own);
      quote = await marketPriceForCard(card, s, { ...fresh, printing: own, description });
      const fallback = quote?.source.englishFallback ? quote.source.printingId : null;
      if (fallback && !done.has(fallback)) await snapshot(await fetchPrinting(fallback));
    } catch (e) {
      console.error(`cron prices: card ${card.id} failed`, e);
      continue;
    }
    if (!appraise || !node || !quote?.adjustedUsd || Number(quote.adjustedUsd) <= 0) continue;
    // A write waits up to ENS_WRITE_TIMEOUT_MS: only start one that fits in the budget, the cap and a healthy signer.
    if (!halted && attempts >= MAX_ENS_WRITES_PER_RUN) halted = `the cap of ${MAX_ENS_WRITES_PER_RUN} writes per run`;
    if (!halted && Date.now() - start > BUDGET_MS - ENS_WRITE_TIMEOUT_MS) halted = "the time budget";
    if (halted) {
      deferred++;
      continue;
    }
    attempts++;
    const outcome = await publishAppraisalRecord(card.id, node, quote.adjustedUsd, deps);
    if (outcome === "written") appraised++;
    else if (outcome === "failed" || outcome === "timeout" || outcome === "no-funds") {
      appraisalErrors++;
      console.warn(`cron prices: card ${card.id}'s ENS appraisal ${outcome === "timeout" ? "did not confirm in time" : outcome === "no-funds" ? "failed: the signer is out of ETH" : "write failed"}`);
    }
    if (outcome === "timeout") halted = "a write that did not confirm in time";
    else if (outcome === "no-funds") halted = "the signer running out of ETH";
    else if (outcome === "stuck") halted = "a stuck signer transaction";
  }
  if (deferred > 0) console.warn(`cron prices: ${deferred} ENS appraisal${deferred === 1 ? "" : "s"} left for the next run (stopped at ${halted})`);
  return result(deferred > 0);
}
