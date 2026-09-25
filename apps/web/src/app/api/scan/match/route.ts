import { NextResponse } from "next/server";
import { z } from "zod";
import { getCardIndex, IndexUnavailableError, type LoadedCardIndex } from "@/lib/card-index";
import { matchVector } from "@/lib/card-match";
import { getDb } from "@/lib/db/client";
import { scanDrafts, type CandidateJson } from "@/lib/db/schema";
import { HttpError, parseBody, withAuth } from "@/lib/http";
import { requireVendor } from "@/lib/scan";
import { ScryfallUnavailableError } from "@/lib/scryfall";

// Reads the index from disk and keeps it in this server process.
export const runtime = "nodejs";

export const POST = withAuth(async (req, user) => {
  requireVendor(user);
  let index: LoadedCardIndex;
  try {
    index = await getCardIndex();
  } catch (e) {
    if (e instanceof IndexUnavailableError) {
      console.warn(e.message);
      throw new HttpError("INDEX_UNAVAILABLE", "The card image index is not available on this server; search by name instead", 503);
    }
    throw e;
  }
  const { dims } = index.manifest;
  const body = await parseBody(z.object({ vector: z.array(z.number().finite()).length(dims, `must have exactly ${dims} values`) }), req);
  let match: Awaited<ReturnType<typeof matchVector>>;
  try {
    match = await matchVector(index, body.vector);
  } catch (e) {
    if (e instanceof ScryfallUnavailableError) throw new HttpError("SCRYFALL_UNAVAILABLE", "Scryfall is rate limiting us, try again in a moment", 503);
    throw e;
  }
  const draftId = crypto.randomUUID();
  const { candidates, confident } = match;
  // The draft records what was offered (with scores), not every sibling printing.
  const stored: CandidateJson[] = candidates.map((c) => ({ ...c, siblings: undefined, siblingCount: c.siblings.length }));
  await getDb().insert(scanDrafts).values({ id: draftId, vendorWallet: user.wallet, candidates: stored, method: "embedding" });
  return NextResponse.json({ draftId, confident, candidates });
});
