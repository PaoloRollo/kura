import { NextResponse } from "next/server";
import { z } from "zod";
import { runAppraiseFor } from "@/lib/appraise";
import { parseBody, withAuth } from "@/lib/http";

/** A signed 10-minute appraisal of a sharded card at its market price per shard (Task 7 buyouts). */
export const POST = withAuth(async (req, user) =>
  NextResponse.json(await runAppraiseFor(user.did, await parseBody(z.object({ cardId: z.string().regex(/^\d+$/) }), req))));
