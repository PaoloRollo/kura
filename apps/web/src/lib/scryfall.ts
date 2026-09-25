import "server-only";
import { eq, sql } from "drizzle-orm";
import { setCode as normaliseSet, slugify } from "@kura/shared";
import { getDb } from "@/lib/db/client";
import { scryfallCache, type CandidateJson } from "@/lib/db/schema";

export type Candidate = CandidateJson;

export class ScryfallUnavailableError extends Error {
  constructor(message = "Scryfall unavailable") {
    super(message);
    this.name = "ScryfallUnavailableError";
  }
}

/** Scryfall rejected the query itself (HTTP 400), e.g. unbalanced syntax typed by the vendor. */
export class ScryfallBadQueryError extends Error {
  constructor(message = "Scryfall rejected the query") {
    super(message);
    this.name = "ScryfallBadQueryError";
  }
}

type ImageUris = { small?: string; normal?: string; large?: string; png?: string };
export type ScryfallCard = {
  id: string;
  name: string;
  printed_name?: string;
  lang: string;
  set: string;
  set_name: string;
  collector_number: string;
  illustration_id?: string;
  rarity: string;
  colors?: string[];
  type_line?: string;
  cmc?: number;
  released_at?: string;
  image_uris?: ImageUris;
  card_faces?: { name?: string; printed_name?: string; illustration_id?: string; image_uris?: ImageUris }[];
  prices: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null; eur?: string | null; eur_foil?: string | null };
  finishes?: string[];
};

const BASE = "https://api.scryfall.com";
// Scryfall asks for 50-100 ms between requests (about 10/s).
const MIN_SPACING_MS = 100;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const HEADERS = { "User-Agent": "Kura/0.1 (hackathon)", Accept: "application/json" };

const reportedCacheFailures = new Set<string>();

/** Logs a Scryfall cache failure once per operation and cause, so an outage doesn't log on every request. */
export function reportCacheFailure(op: "read" | "write", e: unknown) {
  const cause = (e as { cause?: { code?: string } })?.cause?.code ?? (e instanceof Error ? e.message.split("\n")[0] : String(e));
  const key = `${op}:${cause}`;
  if (reportedCacheFailures.has(key)) return;
  reportedCacheFailures.add(key);
  console.error(`scryfall cache ${op} failed (logged once per cause)`, e);
}

export class Scryfall {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private lastAt = 0;

  constructor(opts: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Serialise requests and keep at least MIN_SPACING_MS between them. */
  private async request<T>(path: string): Promise<T | null> {
    const run = async (): Promise<T | null> => {
      const wait = Math.max(0, this.lastAt + MIN_SPACING_MS - this.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = this.now();
      let res: Response;
      try {
        res = await this.fetchImpl(`${BASE}${path}`, { headers: HEADERS });
      } catch (e) {
        throw new ScryfallUnavailableError(String(e));
      }
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new ScryfallUnavailableError(`status ${res.status}`);
      if (res.status === 400) throw new ScryfallBadQueryError();
      if (!res.ok) throw new Error(`scryfall ${res.status}`);
      return (await res.json()) as T;
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** `normal` prefers the PNG (transparent rounded corners, no white edges); `small` stays a light JPG for lists. */
  static imageOf(card: ScryfallCard): { normal: string; small: string } {
    const uris = card.image_uris ?? card.card_faces?.find((f) => f.image_uris)?.image_uris ?? {};
    return { normal: uris.png ?? uris.normal ?? uris.large ?? "", small: uris.small ?? uris.normal ?? "" };
  }

  toCandidate(card: ScryfallCard): Candidate {
    return Scryfall.toCandidate(card);
  }

  static toCandidate(card: ScryfallCard): Candidate {
    const img = Scryfall.imageOf(card);
    return {
      scryfallId: card.id,
      name: card.name,
      printedName: card.printed_name ?? card.card_faces?.find((f) => f.printed_name)?.printed_name ?? null,
      lang: card.lang,
      set: card.set,
      setName: card.set_name,
      collectorNumber: card.collector_number,
      rarity: card.rarity,
      image: img.normal,
      imageSmall: img.small,
      prices: { usd: card.prices.usd ?? null, usdFoil: card.prices.usd_foil ?? null, eur: card.prices.eur ?? null },
      finishes: card.finishes ?? [],
      slug: slugify(card.name),
      setCode: normaliseSet(card.set),
    };
  }

  private async cachePut(card: ScryfallCard): Promise<void> {
    const c = this.toCandidate(card);
    await getDb()
      .insert(scryfallCache)
      .values({
        scryfallId: card.id,
        name: card.name,
        printedName: c.printedName,
        setCode: c.setCode,
        setName: card.set_name,
        collectorNumber: card.collector_number,
        lang: card.lang,
        rarity: card.rarity,
        colors: card.colors ?? [],
        typeLine: card.type_line ?? "",
        manaValue: card.cmc?.toString() ?? null,
        releasedAt: card.released_at ?? null,
        imageNormal: c.image,
        imageSmall: c.imageSmall,
        prices: { usd: c.prices.usd, usd_foil: c.prices.usdFoil, eur: c.prices.eur },
        finishes: c.finishes,
        raw: card,
        fetchedAt: new Date(this.now()),
      })
      .onConflictDoUpdate({ target: scryfallCache.scryfallId, set: { prices: { usd: c.prices.usd, usd_foil: c.prices.usdFoil, eur: c.prices.eur }, raw: card, fetchedAt: new Date(this.now()) } });
  }

  /** Same upsert as cachePut, batched into one insert for every card (used for a name's full printings list). */
  private async cachePutMany(cards: ScryfallCard[]): Promise<void> {
    if (cards.length === 0) return;
    // A name's printings never repeat an id within one page, but stay defensive against a duplicate
    // key in the same INSERT, which Postgres rejects ("ON CONFLICT DO UPDATE command cannot affect
    // row a second time").
    const byId = new Map(cards.map((card) => [card.id, card]));
    const rows = [...byId.values()].map((card) => {
      const c = this.toCandidate(card);
      return {
        scryfallId: card.id,
        name: card.name,
        printedName: c.printedName,
        setCode: c.setCode,
        setName: card.set_name,
        collectorNumber: card.collector_number,
        lang: card.lang,
        rarity: card.rarity,
        colors: card.colors ?? [],
        typeLine: card.type_line ?? "",
        manaValue: card.cmc?.toString() ?? null,
        releasedAt: card.released_at ?? null,
        imageNormal: c.image,
        imageSmall: c.imageSmall,
        prices: { usd: c.prices.usd, usd_foil: c.prices.usdFoil, eur: c.prices.eur },
        finishes: c.finishes,
        raw: card,
        fetchedAt: new Date(this.now()),
      };
    });
    await getDb()
      .insert(scryfallCache)
      .values(rows)
      .onConflictDoUpdate({
        target: scryfallCache.scryfallId,
        set: { prices: sql`excluded.prices`, raw: sql`excluded.raw`, fetchedAt: sql`excluded.fetched_at` },
      });
  }

  private async cacheGet(id: string): Promise<ScryfallCard | null> {
    const rows = await getDb().select().from(scryfallCache).where(eq(scryfallCache.scryfallId, id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    if (this.now() - row.fetchedAt.getTime() > CACHE_TTL_MS) return null;
    return row.raw as ScryfallCard;
  }

  // The cache is best-effort here: a database outage must not take card lookups (and token metadata) down with it.
  async getById(id: string): Promise<Candidate | null> {
    const cached = await this.cacheGet(id).catch((e) => {
      reportCacheFailure("read", e);
      return null;
    });
    if (cached) return this.toCandidate(cached);
    const card = await this.request<ScryfallCard>(`/cards/${encodeURIComponent(id)}`);
    if (!card) return null;
    await this.cachePut(card).catch((e) => reportCacheFailure("write", e));
    return this.toCandidate(card);
  }

  async named(q: { name: string; set?: string; lang?: string }): Promise<Candidate | null> {
    const set = q.set ? normaliseSet(q.set) : undefined;
    if (q.lang && q.lang !== "en") {
      const query = `!"${q.name}"${set ? ` set:${set}` : ""} lang:${q.lang} unique:prints`;
      const list = await this.request<{ data: ScryfallCard[] }>(`/cards/search?q=${encodeURIComponent(query)}`);
      const card = list?.data?.[0];
      if (!card) return null;
      await this.cachePut(card);
      return this.toCandidate(card);
    }
    const params = new URLSearchParams({ fuzzy: q.name });
    if (set) params.set("set", set);
    const card = await this.request<ScryfallCard>(`/cards/named?${params.toString()}`);
    if (!card) return null;
    await this.cachePut(card);
    return this.toCandidate(card);
  }

  /** A search Scryfall rejects as malformed is simply one with no results. */
  private async searchCards(query: string, extra = ""): Promise<ScryfallCard[]> {
    try {
      const list = await this.request<{ data: ScryfallCard[] }>(`/cards/search?q=${encodeURIComponent(query)}${extra}`);
      return list?.data ?? [];
    } catch (e) {
      if (e instanceof ScryfallBadQueryError) return [];
      throw e;
    }
  }

  async search(query: string, limit = 5): Promise<Candidate[]> {
    const cards = (await this.searchCards(query)).slice(0, limit);
    await Promise.all(cards.map((c) => this.cachePut(c)));
    return cards.map((c) => this.toCandidate(c));
  }

  /** Every printing of an exact card name, in every language, oldest first (first page: up to 175). */
  async printingsOf(name: string): Promise<ScryfallCard[]> {
    // Scryfall has no escape inside quotes, so a name holding double quotes goes in single quotes.
    const exact = name.includes('"') ? `!'${name}'` : `!"${name}"`;
    const cards = await this.searchCards(`${exact} unique:prints lang:any`, "&order=released&dir=asc");
    await this.cachePutMany(cards);
    return cards;
  }
}
