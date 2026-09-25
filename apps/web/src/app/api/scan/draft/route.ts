import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, withAuth } from "@/lib/http";
import { recordScanDraft } from "@/lib/scan-draft";
import { requireVendor } from "@/lib/scan";

const CandidateSchema = z.object({
  scryfallId: z.string(),
  name: z.string(),
  printedName: z.string().nullable(),
  lang: z.string(),
  set: z.string(),
  setName: z.string(),
  collectorNumber: z.string(),
  rarity: z.string(),
  image: z.string(),
  imageSmall: z.string(),
  prices: z.object({ usd: z.string().nullable(), usdFoil: z.string().nullable(), eur: z.string().nullable() }),
  finishes: z.array(z.string()),
  slug: z.string(),
  setCode: z.string(),
});

/** Records the card the vendor picked out of manual search results, so the scan is auditable like an embedding match. */
export const POST = withAuth(async (req, user) => {
  requireVendor(user);
  const { candidate } = await parseBody(z.object({ candidate: CandidateSchema }), req);
  const draftId = await recordScanDraft(user.wallet, [candidate], "manual");
  return NextResponse.json({ draftId });
});
