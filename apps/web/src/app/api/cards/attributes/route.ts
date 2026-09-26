import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { inArray as ponderInArray } from "@ponder/client";
import { artistOf, type CardAttributes } from "@/lib/card-attributes";
import { getDb } from "@/lib/db/client";
import { scryfallCache } from "@/lib/db/schema";
import { jsonError } from "@/lib/http";
import { ponderServer, schema } from "@/lib/ponder-server";
import { t } from "@/lib/ponder-bridge";
import { scryfall } from "@/lib/scryfall";

/** Most ids one request may ask for. */
export const MAX_IDS = 100;
/** Most Scryfall fetches (cache misses) one request may cause. */
export const MAX_FETCHES = 10;
const SCRYFALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which of `ids` are the printing of some vault card; none when the indexer is unreachable. */
async function vaultIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  try {
    const rows = (await ponderServer().db.select({ scryfallId: t(schema.cards.scryfallId) }).from(t(schema.cards))
      .where(ponderInArray(t(schema.cards.scryfallId), ids))) as { scryfallId: string }[];
    return new Set(rows.map((r) => r.scryfallId));
  } catch (e) {
    console.error("attributes: indexer unavailable, not fetching misses", e);
    return new Set();
  }
}

/**
 * Public: set, rarity, colors, lang, usd, artist, name and image per scryfall id, from the app cache. A cache miss is
 * fetched from Scryfall only for a vault card's printing, at most MAX_FETCHES per request; other misses are absent.
 */
export async function GET(req: Request) {
  const raw = (new URL(req.url).searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.some((s) => !SCRYFALL_ID.test(s))) return jsonError("BAD_REQUEST", "ids must be Scryfall ids", 400);
  const ids = [...new Set(raw.map((s) => s.toLowerCase()))];
  if (ids.length > MAX_IDS) return jsonError("BAD_REQUEST", `at most ${MAX_IDS} ids`, 400);
  if (ids.length === 0) return NextResponse.json({});
  const out: Record<string, CardAttributes> = {};
  try {
    const rows = await getDb().select().from(scryfallCache).where(inArray(scryfallCache.scryfallId, ids));
    for (const r of rows) out[r.scryfallId] = { set: r.setCode, setName: r.setName, rarity: r.rarity, colors: r.colors, lang: r.lang, usd: r.prices.usd ?? null, artist: artistOf(r.raw), name: r.name, image: r.imageNormal || null };
  } catch (e) {
    console.error("attributes: database unavailable", e);
    return jsonError("UNAVAILABLE", "card data is temporarily unavailable", 503);
  }
  const uncached = ids.filter((id) => !out[id]);
  const inVault = await vaultIds(uncached);
  const vaultMisses = uncached.filter((id) => inVault.has(id));
  const missing = vaultMisses.slice(0, MAX_FETCHES);
  const s = scryfall();
  for (const id of missing) {
    const c = await s.getById(id).catch(() => null);
    if (c) out[id] = { set: c.setCode, setName: c.setName, rarity: c.rarity, colors: [], lang: c.lang, usd: c.prices.usd, artist: null, name: c.name, image: c.image || null };
  }
  // getById caches the raw card, so a second read picks up the artist for the ones just fetched.
  const fetched = missing.filter((id) => out[id]);
  if (fetched.length > 0) {
    const again = await getDb().select({ scryfallId: scryfallCache.scryfallId, raw: scryfallCache.raw }).from(scryfallCache).where(inArray(scryfallCache.scryfallId, fetched)).catch(() => []);
    for (const r of again) if (out[r.scryfallId]) out[r.scryfallId]!.artist = artistOf(r.raw);
  }
  // A capped answer is partial: don't let a cache keep it, so the next request fetches the rest.
  const partial = vaultMisses.length > missing.length;
  return NextResponse.json(out, { headers: { "cache-control": partial ? "no-store" : "public, max-age=300" } });
}
