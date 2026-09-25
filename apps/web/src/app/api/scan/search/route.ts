import { NextResponse } from "next/server";
import { withAuth, HttpError } from "@/lib/http";
import { Scryfall, ScryfallUnavailableError } from "@/lib/scryfall";
import { requireVendor } from "@/lib/scan";

export const GET = withAuth(async (req, user) => {
  requireVendor(user);
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ candidates: [] });
  try {
    const candidates = await new Scryfall().search(`${q} unique:prints`, 5);
    return NextResponse.json({ candidates });
  } catch (e) {
    if (e instanceof ScryfallUnavailableError) throw new HttpError("SCRYFALL_UNAVAILABLE", "Scryfall is rate limiting us", 503);
    throw e;
  }
});
