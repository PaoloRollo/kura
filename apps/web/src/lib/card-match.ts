import "server-only";
import type { CardIndexRow } from "@/lib/card-index-format";
import type { LoadedCardIndex } from "@/lib/card-index";
import { topK } from "@/lib/card-vectors";
import { isConfident } from "@/lib/embed-spec";
import { Scryfall, scryfall as sharedScryfall, ScryfallUnavailableError, type Candidate, type ScryfallCard } from "@/lib/scryfall";

export type IndexHit = { row: CardIndexRow; score: number };

export type ArtworkGroup =
  | { kind: "ok"; row: CardIndexRow; score: number; primary: ScryfallCard; siblings: ScryfallCard[] }
  | { kind: "failed"; row: CardIndexRow; score: number; error: unknown }
  | { kind: "missing"; row: CardIndexRow; score: number };

const hasIllustration = (card: ScryfallCard, illustration: string) =>
  card.illustration_id === illustration || (card.card_faces ?? []).some((f) => f.illustration_id === illustration);

const releasedAt = (c: ScryfallCard) => c.released_at ?? "9999";

/**
 * One group per matched artwork, best score first. A later hit on an artwork already seen is dropped.
 * Siblings are every printing (any set, any language) carrying that illustration, oldest first; the
 * primary is the printing the index row came from, or the oldest sibling when it is not in the list.
 */
export function groupSiblings(hits: IndexHit[], printings: Map<string, ScryfallCard[] | Error>): ArtworkGroup[] {
  const seen = new Set<string>();
  const groups: ArtworkGroup[] = [];
  for (const { row, score } of hits) {
    if (seen.has(row.illustration_id)) continue;
    seen.add(row.illustration_id);
    const list = printings.get(row.name);
    if (list instanceof Error) {
      groups.push({ kind: "failed", row, score, error: list });
      continue;
    }
    // Array.prototype.sort is stable, so printings released the same day keep Scryfall's order.
    const siblings = (list ?? []).filter((c) => hasIllustration(c, row.illustration_id)).sort((a, b) => releasedAt(a).localeCompare(releasedAt(b)));
    if (siblings.length === 0) {
      groups.push({ kind: "missing", row, score });
      continue;
    }
    groups.push({ kind: "ok", row, score, primary: siblings.find((c) => c.id === row.scryfall_id) ?? siblings[0], siblings });
  }
  return groups;
}

export type MatchCandidate = Candidate & { score: number; illustrationId: string; siblings: Candidate[] };

export const MATCH_TOP_K = 8;
const MAX_SIBLINGS = 60;
const PRINTINGS_TTL_MS = 60 * 60 * 1000;
const printingsCache = new Map<string, { at: number; cards: ScryfallCard[] }>();

/** For tests: forget memoised printings lists. */
export function clearPrintingsCacheForTests() {
  printingsCache.clear();
}

async function printingsOf(scryfall: Scryfall, name: string): Promise<ScryfallCard[]> {
  const hit = printingsCache.get(name);
  if (hit && Date.now() - hit.at < PRINTINGS_TTL_MS) return hit.cards;
  const cards = await scryfall.printingsOf(name);
  if (printingsCache.size > 500) printingsCache.clear();
  printingsCache.set(name, { at: Date.now(), cards });
  return cards;
}

/**
 * Nearest artworks for a query vector, enriched from Scryfall, and whether the best one is a confident
 * match. A candidate whose Scryfall lookup fails is dropped; only when every lookup failed because
 * Scryfall is unavailable does this throw.
 */
export async function matchVector(index: LoadedCardIndex, vector: number[], scryfall: Scryfall = sharedScryfall()): Promise<{ candidates: MatchCandidate[]; confident: boolean }> {
  const hits: IndexHit[] = topK(index.vectors, vector, MATCH_TOP_K).map((h) => ({ row: index.meta[h.row], score: h.score }));
  // Judged on the raw ranking (one score per artwork), before any candidate is dropped below.
  const artworkScores = [...new Map(hits.map((h) => [h.row.illustration_id, h.score] as const)).values()];
  const confident = isConfident(artworkScores);
  const names = [...new Set(hits.map((h) => h.row.name))];
  const printings = new Map<string, ScryfallCard[] | Error>();
  await Promise.all(
    names.map(async (name) => {
      try {
        printings.set(name, await printingsOf(scryfall, name));
      } catch (e) {
        printings.set(name, e instanceof Error ? e : new Error(String(e)));
      }
    }),
  );

  const out: MatchCandidate[] = [];
  const failures: unknown[] = [];
  for (const g of groupSiblings(hits, printings)) {
    const base = { score: Math.round(g.score * 10_000) / 10_000, illustrationId: g.row.illustration_id };
    try {
      if (g.kind === "ok") {
        out.push({ ...Scryfall.toCandidate(g.primary), ...base, siblings: g.siblings.slice(0, MAX_SIBLINGS).map((c) => Scryfall.toCandidate(c)) });
      } else if (g.kind === "missing") {
        // Past the first page of printings (basic lands): fall back to the indexed printing alone.
        const c = await scryfall.getById(g.row.scryfall_id);
        if (c) out.push({ ...c, ...base, siblings: [c] });
      } else {
        failures.push(g.error);
      }
    } catch (e) {
      failures.push(e);
    }
  }
  if (out.length === 0 && failures.length > 0 && failures.every((e) => e instanceof ScryfallUnavailableError)) {
    throw new ScryfallUnavailableError("Scryfall unavailable for every candidate");
  }
  for (const e of failures) if (!(e instanceof ScryfallUnavailableError)) console.warn("scan match: dropped a candidate", e);
  return { candidates: out, confident: confident && out[0]?.illustrationId === hits[0]?.row.illustration_id };
}
