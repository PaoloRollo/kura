import { NextResponse } from "next/server";
import { z } from "zod";
import { runAppraise } from "@/lib/appraise";
import { parseBody, withAuth } from "@/lib/http";

/** A signed 10-minute appraisal of a sharded card at its market price per shard (Task 7 buyouts). */
export const POST = withAuth(async (req) => NextResponse.json(await runAppraise(await parseBody(z.object({ cardId: z.string().regex(/^\d+$/) }), req))));
