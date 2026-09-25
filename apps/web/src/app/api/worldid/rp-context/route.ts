import { NextResponse } from "next/server";
import { z } from "zod";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { parseBody, withAuth } from "@/lib/http";

const Body = z.object({ action: z.enum(["bid", "release"]) });

export const POST = withAuth(async (req) => {
  const { action } = await parseBody(Body, req);
  const { sig, nonce, createdAt, expiresAt } = signRequest({ signingKeyHex: process.env.WORLD_RP_SIGNING_KEY!, action });
  return NextResponse.json({ rp_id: process.env.WORLD_RP_ID, nonce, created_at: createdAt, expires_at: expiresAt, signature: sig });
});
