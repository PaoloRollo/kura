// Explore (TQ4jp, Z6BlV0, aUlMV, NWOiJ): auction items joined from the indexer rows, the Live / Ending soon / Upcoming /
// Ended tabs, filters kept in the URL query, search and sort. Pure, so node tests cover it.
import { q96ToUsdcPerShard } from "@kura/shared";
import { poolValuePrice, type PoolPrice } from "@/lib/market";
import { metaCardName } from "@/lib/meta";
import { vsMarket } from "@/lib/pricing";

const SECONDS_PER_BLOCK = 12;
/** "Ending soon": at most this many blocks left (about an hour). */
export const ENDING_SOON_BLOCKS = 300n;
/** "At market": clearing within ±5% of the market price per shard. */
export const AT_MARKET_BAND = 0.05;

type Hex = `0x${string}`;
const lc = (s: string) => s.toLowerCase();

export type ExploreTab = "live" | "soon" | "upcoming" | "ended";
export const EXPLORE_TABS: readonly { value: ExploreTab; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "soon", label: "Ending soon" },
  { value: "upcoming", label: "Upcoming" },
  { value: "ended", label: "Ended" },
];

export type ExploreSort = "ending" | "newest" | "price-asc" | "price-desc" | "vs-market";
export const SORTS: readonly { value: ExploreSort; label: string }[] = [
  { value: "ending", label: "Ending soonest" },
  { value: "newest", label: "Newest" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "vs-market", label: "Furthest below market" },
];

export type VsBand = "below" | "at" | "above";
export type EndsBand = "1h" | "1d" | "later";
export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
export const COLORS = [
  { value: "W", label: "White" },
  { value: "U", label: "Blue" },
  { value: "B", label: "Black" },
  { value: "R", label: "Red" },
  { value: "G", label: "Green" },
  { value: "C", label: "Colorless" },
] as const;
export const VS_BANDS: readonly { value: VsBand; label: string }[] = [
  { value: "below", label: "Below market" },
  { value: "at", label: "At market" },
  { value: "above", label: "Above market" },
];
export const ENDS_BANDS: readonly { value: EndsBand; label: string }[] = [
  { value: "1h", label: "< 1 h" },
  { value: "1d", label: "< 1 day" },
  { value: "later", label: "Later" },
];

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", ja: "Japanese", de: "German", fr: "French", it: "Italian", es: "Spanish", pt: "Portuguese",
  ru: "Russian", ko: "Korean", zhs: "Chinese", zht: "Chinese", zh: "Chinese",
};
export const languageName = (code: string) => LANGUAGE_NAMES[lc(code)] ?? code.toUpperCase();

// ---------------------------------------------------------------------------------------------------------------------
// Items

export type AuctionItem = {
  cardId: bigint;
  auction: Hex;
  shardToken: Hex;
  name: string;
  image: string | null;
  /** Set code, upper case ("LEA"); null until the attributes load. */
  set: string | null;
  setName: string | null;
  rarity: string | null;
  colors: string[];
  condition: string;
  language: string;
  ensName: string;
  /** USDC per whole shard: live while the auction runs, final once settled; null when it did not graduate. */
  clearing: bigint | null;
  totalShards: number;
  forSale: number;
  startBlock: bigint;
  endBlock: bigint;
  /** live: accepting bids; awaiting: past endBlock, not settled yet; settled: settled. */
  status: "live" | "awaiting" | "settled";
  graduated: boolean | null;
  /** The whole card's market price (USDC), from lib/pricing's quote; null without one. */
  market: bigint | null;
  /** The card's Uniswap pool price per whole shard while it trades; null without a pool or once frozen. */
  poolPrice: bigint | null;
  /** The pool price (else the clearing) vs market per shard as a fraction (+0.096 is 9.6% above); null without both. */
  premium: number | null;
  /** Unix seconds the sharding was last updated (settlement time for settled ones). */
  updatedAt: number;
};

type ActiveRow = { auction: Hex; cardId: bigint; shardToken: Hex; startBlock: bigint; endBlock: bigint };
type ShardingRow = {
  shardToken: Hex; cardId: bigint; auction: Hex; totalShards: number; forSale: number; floorPriceQ96: bigint; startBlock: bigint; endBlock: bigint;
  settled: boolean; graduated: boolean | null; clearingPriceQ96: bigint | null; clearingUsdcPerShard: bigint | null; updatedAt: number;
};
type CardRow = { id: bigint; scryfallId: string; condition: string; language: string; label: string; ensName: string };
type Attrs = { set: string; setName: string; rarity: string; colors: string[] };
type Meta = { name: string; image: string };

/** A card's display name from its metadata ("Black Lotus (LEA) #1" → "Black Lotus"), else its label. */
export const nameOf = (meta: Pick<Meta, "name"> | undefined | null, card: Pick<CardRow, "label">) => (meta?.name ? metaCardName(meta.name) : card.label);

/** The clearing price to show: the indexer's live or final value; before the first checkpoint, the floor. */
export function clearingOf(s: Pick<ShardingRow, "settled" | "graduated" | "clearingUsdcPerShard" | "clearingPriceQ96" | "floorPriceQ96">): bigint | null {
  if (s.graduated === false) return null;
  if (s.clearingUsdcPerShard != null) return s.clearingUsdcPerShard;
  if (s.settled) return null;
  return q96ToUsdcPerShard(s.clearingPriceQ96 ?? s.floorPriceQ96);
}

/**
 * Every auction the Explore tabs can show: the active ones (live, or past their end block and awaiting settle) and the
 * settled shardings, newest settlement first. Rows without their card or sharding (indexer mid-sync) are skipped.
 */
export function buildAuctionItems(p: {
  active: readonly ActiveRow[];
  shardings: readonly ShardingRow[];
  cards: readonly CardRow[];
  metas: ReadonlyMap<string, Meta>;
  attributes: Readonly<Record<string, Attrs>>;
  /** Whole-card market price (USDC) by card id. */
  markets: ReadonlyMap<string, bigint | null>;
  block: bigint;
  /** The indexer's pools, for settled cards whose shards trade. */
  pools?: readonly PoolPrice[];
}): AuctionItem[] {
  const cards = new Map(p.cards.map((c) => [c.id.toString(), c]));
  const byToken = new Map(p.shardings.map((s) => [lc(s.shardToken), s]));
  const item = (s: ShardingRow, status: AuctionItem["status"], startBlock: bigint, endBlock: bigint): AuctionItem | null => {
    const card = cards.get(s.cardId.toString());
    if (!card) return null;
    const a = p.attributes[card.scryfallId];
    const meta = p.metas.get(card.id.toString());
    const clearing = clearingOf(s);
    const market = p.markets.get(card.id.toString()) ?? null;
    const poolPrice = poolValuePrice(p.pools, s.shardToken);
    return {
      cardId: card.id, auction: s.auction, shardToken: s.shardToken, name: nameOf(meta, card), image: meta?.image || null,
      set: a?.set ? a.set.toUpperCase() : null, setName: a?.setName ?? null, rarity: a?.rarity ?? null, colors: a?.colors ?? [],
      condition: card.condition, language: card.language, ensName: card.ensName, clearing, totalShards: s.totalShards, forSale: s.forSale,
      startBlock, endBlock, status, graduated: s.graduated, market, poolPrice, premium: vsMarket(poolPrice ?? clearing, market, s.totalShards), updatedAt: s.updatedAt,
    };
  };
  const out: AuctionItem[] = [];
  const seen = new Set<string>();
  for (const a of p.active) {
    const s = byToken.get(lc(a.shardToken));
    if (!s || s.settled) continue;
    const it = item(s, a.endBlock > p.block ? "live" : "awaiting", a.startBlock, a.endBlock);
    if (it) {
      out.push(it);
      seen.add(lc(a.auction));
    }
  }
  const settled = p.shardings.filter((s) => s.settled && !seen.has(lc(s.auction))).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of settled) {
    const it = item(s, "settled", s.startBlock, s.endBlock);
    if (it) out.push(it);
  }
  return out;
}

/** Whether an item belongs to a tab. Upcoming is always empty: a CCA opens in the same transaction that shards the card. */
export function inTab(it: AuctionItem, tab: ExploreTab, block: bigint): boolean {
  if (tab === "upcoming") return false;
  if (tab === "ended") return it.status !== "live";
  if (it.status !== "live") return false;
  return tab === "live" || it.endBlock - block <= ENDING_SOON_BLOCKS;
}

export const tabCount = (items: readonly AuctionItem[], tab: ExploreTab, block: bigint) => items.filter((i) => inTab(i, tab, block)).length;

/** Time elapsed 0..1 from start and end block. */
export function elapsed(it: Pick<AuctionItem, "startBlock" | "endBlock">, block: bigint): number {
  const total = it.endBlock - it.startBlock;
  if (total <= 0n) return 1;
  const done = block - it.startBlock;
  return Math.min(1, Math.max(0, Number(done) / Number(total)));
}

export function vsBand(premium: number | null): VsBand | null {
  if (premium == null) return null;
  if (premium < -AT_MARKET_BAND) return "below";
  if (premium > AT_MARKET_BAND) return "above";
  return "at";
}

export function endsBand(it: Pick<AuctionItem, "endBlock" | "status">, block: bigint): EndsBand | null {
  if (it.status !== "live") return null;
  const s = Number(it.endBlock - block) * SECONDS_PER_BLOCK;
  return s < 3600 ? "1h" : s < 86_400 ? "1d" : "later";
}

// ---------------------------------------------------------------------------------------------------------------------
// Filters (in the URL query)

export type ExploreFilters = {
  q: string;
  tab: ExploreTab;
  sort: ExploreSort;
  set: string[];
  cond: string[];
  lang: string[];
  rarity: string[];
  color: string[];
  vs: VsBand[];
  ends: EndsBand[];
  /** Clearing price per shard range, in whole dollars; null is open-ended. */
  pmin: number | null;
  pmax: number | null;
  view: "grid" | "list";
};

export const DEFAULT_FILTERS: ExploreFilters = {
  q: "", tab: "live", sort: "ending", set: [], cond: [], lang: [], rarity: [], color: [], vs: [], ends: [], pmin: null, pmax: null, view: "grid",
};

type Query = { get(key: string): string | null };
const list = (q: Query, key: string) => (q.get(key) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const oneOf = <T extends string>(v: string | null, options: readonly { value: T }[], fallback: T): T => options.find((o) => o.value === v)?.value ?? fallback;
const num = (v: string | null) => (v != null && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

export function parseFilters(q: Query): ExploreFilters {
  const pick = <T extends string>(key: string, options: readonly { value: T }[]) => list(q, key).filter((v): v is T => options.some((o) => o.value === v));
  return {
    q: q.get("q") ?? "",
    tab: oneOf(q.get("tab"), EXPLORE_TABS, "live"),
    sort: oneOf(q.get("sort"), SORTS, "ending"),
    set: list(q, "set").map((s) => s.toUpperCase()),
    cond: list(q, "cond").map((s) => s.toUpperCase()).filter((c) => (CONDITIONS as readonly string[]).includes(c)),
    lang: list(q, "lang").map(lc),
    rarity: list(q, "rarity").map(lc),
    color: list(q, "color").map((s) => s.toUpperCase()).filter((c) => COLORS.some((o) => o.value === c)),
    vs: pick("vs", VS_BANDS),
    ends: pick("ends", ENDS_BANDS),
    pmin: num(q.get("pmin")),
    pmax: num(q.get("pmax")),
    view: q.get("view") === "list" ? "list" : "grid",
  };
}

/** The query string for `f`, defaults left out ("" for all defaults). */
export function filtersToQuery(f: ExploreFilters): string {
  const out = new URLSearchParams();
  if (f.q) out.set("q", f.q);
  if (f.tab !== "live") out.set("tab", f.tab);
  if (f.sort !== "ending") out.set("sort", f.sort);
  for (const k of ["set", "cond", "lang", "rarity", "color", "vs", "ends"] as const) if (f[k].length > 0) out.set(k, f[k].join(","));
  if (f.pmin != null) out.set("pmin", String(f.pmin));
  if (f.pmax != null) out.set("pmax", String(f.pmax));
  if (f.view !== "grid") out.set("view", f.view);
  return out.toString();
}

/** Filters in use (search, tab, sort and view aside); the price range counts once. */
export function activeFilterCount(f: ExploreFilters): number {
  const lists = [f.set, f.cond, f.lang, f.rarity, f.color, f.vs, f.ends].filter((l) => l.length > 0).length;
  return lists + (f.pmin != null || f.pmax != null ? 1 : 0);
}

export const clearFilters = (f: ExploreFilters): ExploreFilters => ({ ...DEFAULT_FILTERS, tab: f.tab, sort: f.sort, view: f.view });

/**
 * Lower case without Latin diacritics, for matching ("Lim-Dûl" → "lim-dul"). Only the combining diacritical marks block
 * (U+0300–U+036F) is dropped, and the result recomposed, so kana voicing marks survive ("ガ" stays distinct from "カ").
 */
export const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC").toLowerCase();

/** Every query word matches the name, set, ENS name, condition or language (code or name); accents are ignored. */
export function matchesSearch(it: AuctionItem, q: string): boolean {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold([it.name, it.set ?? "", it.setName ?? "", it.ensName, it.condition, it.language, languageName(it.language)].join(" "));
  return words.every((w) => hay.includes(w));
}

const dollars = (usdc: bigint) => Number(usdc / 10_000n) / 100;

/** Every filter except the tab and search. */
export function matchesFilters(it: AuctionItem, f: ExploreFilters, block: bigint): boolean {
  if (f.set.length && !(it.set && f.set.includes(it.set))) return false;
  if (f.cond.length && !f.cond.includes(it.condition.toUpperCase())) return false;
  if (f.lang.length && !f.lang.includes(lc(it.language))) return false;
  if (f.rarity.length && !(it.rarity && f.rarity.includes(lc(it.rarity)))) return false;
  if (f.color.length) {
    const colors = it.colors.length === 0 ? ["C"] : it.colors.map((c) => c.toUpperCase());
    if (!f.color.some((c) => colors.includes(c))) return false;
  }
  if (f.vs.length) {
    const b = vsBand(it.premium);
    if (!b || !f.vs.includes(b)) return false;
  }
  if (f.ends.length) {
    const b = endsBand(it, block);
    if (!b || !f.ends.includes(b)) return false;
  }
  if (f.pmin != null || f.pmax != null) {
    const shown = it.poolPrice ?? it.clearing;
    if (shown == null) return false;
    const d = dollars(shown);
    if (f.pmin != null && d < f.pmin) return false;
    if (f.pmax != null && d > f.pmax) return false;
  }
  return true;
}

const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

export function sortItems(items: readonly AuctionItem[], sort: ExploreSort, tab: ExploreTab): AuctionItem[] {
  const out = [...items];
  const price = (it: AuctionItem) => it.poolPrice ?? it.clearing ?? -1n;
  switch (sort) {
    case "ending":
      // Ended: the most recently ended first (awaiting settle before settled).
      return tab === "ended"
        ? out.sort((a, b) => (a.status === b.status ? (a.status === "awaiting" ? cmpBig(b.endBlock, a.endBlock) : b.updatedAt - a.updatedAt) : a.status === "awaiting" ? -1 : 1))
        : out.sort((a, b) => cmpBig(a.endBlock, b.endBlock));
    case "newest":
      return out.sort((a, b) => cmpBig(b.startBlock, a.startBlock));
    case "price-asc":
      return out.sort((a, b) => cmpBig(price(a), price(b)));
    case "price-desc":
      return out.sort((a, b) => cmpBig(price(b), price(a)));
    case "vs-market":
      return out.sort((a, b) => (a.premium ?? Infinity) - (b.premium ?? Infinity));
  }
}

/** The tab's items after search and filters, sorted. */
export function exploreResults(items: readonly AuctionItem[], f: ExploreFilters, block: bigint): AuctionItem[] {
  return sortItems(items.filter((it) => inTab(it, f.tab, block) && matchesSearch(it, f.q) && matchesFilters(it, f, block)), f.sort, f.tab);
}

/** The options each filter offers: what the items have (sets by frequency, then the fixed lists). */
export function filterOptions(items: readonly AuctionItem[]) {
  const count = (values: (string | null)[]) => {
    const m = new Map<string, number>();
    for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
  };
  const prices = items.flatMap((i) => { const p = i.poolPrice ?? i.clearing; return p != null ? [dollars(p)] : []; });
  return {
    sets: count(items.map((i) => i.set)),
    languages: count(items.map((i) => lc(i.language))),
    rarities: count(items.map((i) => (i.rarity ? lc(i.rarity) : null))),
    conditions: count(items.map((i) => i.condition.toUpperCase())),
    priceMin: prices.length ? Math.floor(Math.min(...prices)) : 0,
    priceMax: prices.length ? Math.ceil(Math.max(...prices)) : 0,
  };
}

/** "LEA, LEB" / "Any" for a chip. */
export const chipValue = (values: readonly string[], label: (v: string) => string = (v) => v) => (values.length ? values.map(label).join(", ") : "Any");

export const toggle = <T,>(values: readonly T[], v: T): T[] => (values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);

/** "New in the vault" ages, as TQ4jp shows them: "just now", "2m ago", "5h ago", "yesterday", "3d ago". */
export function shortAgo(timestamp: number, now: number): string {
  const s = Math.max(0, now - timestamp);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2 * 86_400) return "yesterday";
  return `${Math.floor(s / 86_400)}d ago`;
}
