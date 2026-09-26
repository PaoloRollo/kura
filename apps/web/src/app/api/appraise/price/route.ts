import { NextResponse } from "next/server";
import { lookupPrice, defaultDeps } from "@/lib/appraise";
import { jsonError, withAuth } from "@/lib/http";

/** The appraisal's price lookup for a card, without signing: `{ quote, source, pricedAt }`. */
export const GET = withAuth(async (req) => {
  const id = new URL(req.url).searchParams.get("cardId") ?? "";
  if (!/^\d+$/.test(id)) return jsonError("BAD_REQUEST", "cardId required", 400);
  const card = await defaultDeps.loadCard(BigInt(id));
  if (!card) return jsonError("NOT_FOUND", "unknown card", 404);
  const node = await defaultDeps.loadEnsNode(card.id);
  const description = node ? await defaultDeps.loadEnsText(node, "description") : null;
  const out = await lookupPrice(card, description);
  return NextResponse.json({ usd: out.quote?.adjustedUsd ?? null, ...out });
});
