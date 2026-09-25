import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import type { CardIndexRow } from "../../src/lib/card-index-format";
import { parseJsonArray } from "./json-array-stream";
import { fetchWithRetry, scryfallApi } from "./scryfall-http";

type Uris = { small?: string; normal?: string };
export type BulkCard = {
  id: string;
  oracle_id?: string;
  illustration_id?: string;
  name: string;
  set: string;
  collector_number: string;
  lang: string;
  layout: string;
  games?: string[];
  digital?: boolean;
  image_status?: string;
  image_uris?: Uris;
  card_faces?: { name?: string; illustration_id?: string; oracle_id?: string; image_uris?: Uris }[];
  released_at?: string;
  border_color?: string;
  full_art?: boolean;
  promo?: boolean;
  promo_types?: string[];
  frame?: string;
};

export type IndexRow = CardIndexRow;

const SKIP_LAYOUTS = new Set(["token", "double_faced_token", "emblem", "art_series", "vanguard", "scheme", "planar"]);

/** The index rows for a bulk card: one per illustrated face, or none if it is not a scannable paper card. */
export function indexRows(card: BulkCard, size: "small" | "normal"): IndexRow[] {
  if (card.digital || !(card.games ?? []).includes("paper")) return [];
  if (SKIP_LAYOUTS.has(card.layout)) return [];
  if (card.image_status === "placeholder" || card.image_status === "missing") return [];
  const row = (illustration: string | undefined, oracle: string | undefined, uris: Uris | undefined, face: number): IndexRow[] => {
    const image = uris?.[size];
    if (!illustration || !image) return [];
    return [{ illustration_id: illustration, scryfall_id: card.id, oracle_id: oracle ?? null, name: card.name, set: card.set, collector_number: card.collector_number, lang: card.lang, face, image }];
  };
  if (card.image_uris) return row(card.illustration_id ?? card.card_faces?.[0]?.illustration_id, card.oracle_id ?? card.card_faces?.[0]?.oracle_id, card.image_uris, 0);
  return (card.card_faces ?? []).flatMap((f, i) => row(f.illustration_id, f.oracle_id ?? card.oracle_id, f.image_uris, i));
}

type BulkEntry = { type: string; download_uri?: string; jsonl_download_uri?: string; updated_at: string };

/** Find a bulk file via /bulk-data. Newer listings only offer gzipped JSON Lines; older ones a JSON array. */
export async function discoverBulk(type: string): Promise<{ url: string; format: "jsonl" | "json"; updatedAt: string }> {
  const list = await scryfallApi<{ data: BulkEntry[] }>("/bulk-data");
  const entry = list.data.find((d) => d.type === type);
  if (!entry) throw new Error(`bulk file ${type} not listed`);
  if (entry.jsonl_download_uri) return { url: entry.jsonl_download_uri, format: "jsonl", updatedAt: entry.updated_at };
  if (entry.download_uri) return { url: entry.download_uri, format: "json", updatedAt: entry.updated_at };
  throw new Error(`bulk file ${type} has no download uri`);
}

/** Stream-parse a bulk file: only one card is held in memory at a time. */
export async function* streamBulk(type: string): AsyncGenerator<BulkCard> {
  const { url, format } = await discoverBulk(type);
  const res = await fetchWithRetry(url, "*/*");
  if (!res.ok || !res.body) throw new Error(`bulk download ${res.status}`);
  const raw = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  // fetch already undoes a gzip Content-Encoding; a .gz file served as-is still needs gunzip.
  const nodeStream = url.endsWith(".gz") && res.headers.get("content-encoding") !== "gzip" ? raw.pipe(createGunzip()) : raw;
  if (format === "json") {
    for await (const card of parseJsonArray(nodeStream)) yield card as BulkCard;
    return;
  }
  for await (const line of createInterface({ input: nodeStream, crlfDelay: Infinity })) {
    const trimmed = line.trim();
    if (trimmed) yield JSON.parse(trimmed) as BulkCard;
  }
}

type SearchPage = { data: BulkCard[]; has_more?: boolean; next_page?: string };

/**
 * Every artwork printed in a set, one printing each, from the search API (`set:X unique:art`).
 * unique_artwork keeps a single representative printing per artwork, often from another set, so
 * filtering it by set would drop reprinted art (most of a core set such as FDN, and much of 2ED/3ED).
 */
export async function* setArtworks(set: string): AsyncGenerator<BulkCard> {
  let url: string | undefined = `/cards/search?q=${encodeURIComponent(`set:${set}`)}&unique=art&include_extras=true&order=set`;
  while (url) {
    let page: SearchPage;
    try {
      page = await scryfallApi<SearchPage>(url);
    } catch (e) {
      if (String(e).includes("scryfall 404")) return; // no cards: unknown set code
      throw e;
    }
    yield* page.data;
    url = page.has_more ? page.next_page : undefined;
  }
}
