import { NextResponse } from "next/server";
import { eq } from "@ponder/client";
import { jsonError } from "@/lib/http";
import { buildMetadata } from "@/lib/meta";
import { ponderServer, schema } from "@/lib/ponder-server";
import { t, type Row } from "@/lib/ponder-bridge";
import { Scryfall, ScryfallUnavailableError } from "@/lib/scryfall";
import { vaultSiteUri } from "@/lib/vault-site-uri";

/** ERC-721 metadata for card `id` (CardVault.tokenURI points here). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return jsonError("BAD_REQUEST", "id must be an integer", 400);
  const rows = (await ponderServer().db.select().from(t(schema.cards)).where(eq(t(schema.cards.id), BigInt(id))).limit(1)) as Row<typeof schema.cards>[];
  const card = rows[0];
  if (!card) return jsonError("NOT_FOUND", "unknown card", 404);
  let info;
  try {
    info = await new Scryfall().getById(card.scryfallId);
  } catch (e) {
    if (e instanceof ScryfallUnavailableError) return jsonError("UNAVAILABLE", "card data is temporarily unavailable", 503);
    throw e;
  }
  if (!info) return jsonError("NOT_FOUND", "card data unavailable", 404);
  return NextResponse.json(buildMetadata(card, info, await vaultSiteUri()), { headers: { "cache-control": "public, max-age=60" } });
}
