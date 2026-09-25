import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { artistOf, type CardAttributes } from "@/lib/card-attributes";
import { getDb } from "@/lib/db/client";
import { scryfallCache } from "@/lib/db/schema";
import { scryfall } from "@/lib/scryfall";

/** Public: set, rarity, colors, lang, usd and artist per scryfall id, from the app cache (missing ids fetched from Scryfall). */
export async function GET(req: Request) {
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  if (ids.length === 0) return NextResponse.json({});
  const rows = await getDb().select().from(scryfallCache).where(inArray(scryfallCache.scryfallId, ids));
  const out: Record<string, CardAttributes> = {};
  for (const r of rows) out[r.scryfallId] = { set: r.setCode, setName: r.setName, rarity: r.rarity, colors: r.colors, lang: r.lang, usd: r.prices.usd ?? null, artist: artistOf(r.raw) };
  const missing = ids.filter((id) => !out[id]);
  const s = scryfall();
  for (const id of missing) {
    const c = await s.getById(id).catch(() => null);
    if (c) out[id] = { set: c.setCode, setName: c.setName, rarity: c.rarity, colors: [], lang: c.lang, usd: c.prices.usd, artist: null };
  }
  // getById caches the raw card, so a second read picks up the artist for the ones just fetched.
  const fetched = missing.filter((id) => out[id]);
  if (fetched.length > 0) {
    const again = await getDb().select({ scryfallId: scryfallCache.scryfallId, raw: scryfallCache.raw }).from(scryfallCache).where(inArray(scryfallCache.scryfallId, fetched)).catch(() => []);
    for (const r of again) if (out[r.scryfallId]) out[r.scryfallId]!.artist = artistOf(r.raw);
  }
  return NextResponse.json(out, { headers: { "cache-control": "public, max-age=300" } });
}
