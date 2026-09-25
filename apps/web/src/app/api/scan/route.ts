import { NextResponse } from "next/server";
import { parseBody, withAuth } from "@/lib/http";
import { ScanBody, runScan } from "@/lib/scan";

export const POST = withAuth(async (req, user) => NextResponse.json(await runScan(await parseBody(ScanBody, req), user)));
