import "server-only";
import { getDb } from "@/lib/db/client";
import { scanDrafts, type CandidateJson } from "@/lib/db/schema";

export type ScanDraftMethod = "embedding" | "manual";

/** Persist a scan draft: what candidates were offered to the vendor for this scan, and how they got there. */
export async function recordScanDraft(vendorWallet: string, candidates: CandidateJson[], method: ScanDraftMethod): Promise<string> {
  const id = crypto.randomUUID();
  await getDb().insert(scanDrafts).values({ id, vendorWallet, candidates, method });
  return id;
}
