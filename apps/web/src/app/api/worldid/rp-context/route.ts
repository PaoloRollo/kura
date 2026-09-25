import { NextResponse } from "next/server";
import { z } from "zod";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { parseBody, withAuth } from "@/lib/http";
import { requireEnv } from "@/lib/world";

const Body = z.object({ action: z.enum(["bid", "release"]) });

export const POST = withAuth(async (req) => {
  const { action } = await parseBody(Body, req);
  const rpId = requireEnv("WORLD_RP_ID");
  const { sig, nonce, createdAt, expiresAt } = signRequest({ signingKeyHex: requireEnv("WORLD_RP_SIGNING_KEY"), action });
  return NextResponse.json({ rp_id: rpId, nonce, created_at: createdAt, expires_at: expiresAt, signature: sig });
});
