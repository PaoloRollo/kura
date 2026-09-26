import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, withAuth } from "@/lib/http";
import { settleTicket } from "@/lib/release-tickets";
import { requireVendor } from "@/lib/scan";

const Body = z.object({ id: z.string().min(1) });

/** Vendor only: a ticket went through `confirmRelease`, or the vault refused it for good; it is never offered again. */
export const POST = withAuth(async (req, user) => {
  requireVendor(user);
  const { id } = await parseBody(Body, req);
  return NextResponse.json({ consumed: await settleTicket({ id }, "consumed") });
});
