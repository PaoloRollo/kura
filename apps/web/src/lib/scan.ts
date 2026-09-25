import "server-only";
import { z } from "zod";
import deployments from "@/generated/deployments.json";
import type { KuraUser } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { scanDrafts, type CandidateJson } from "@/lib/db/schema";
import { HttpError } from "@/lib/http";
import { Scryfall, ScryfallUnavailableError, type Candidate } from "@/lib/scryfall";
import { RecognitionUnavailableError, recognizeCard, type Recognition, type RecognizeInput } from "@/lib/vision";

export const ScanBody = z.object({
  image: z.string().min(16),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  languageHint: z.string().regex(/^[a-z]{2,3}$/).optional(),
});
export type ScanBody = z.infer<typeof ScanBody>;

type ScryfallLike = { named: Scryfall["named"]; search: Scryfall["search"] };
type Deps = { recognize: (i: RecognizeInput) => Promise<Recognition>; scryfall: ScryfallLike };

export function requireVendor(user: KuraUser) {
  if (user.wallet.toLowerCase() !== deployments.vendor.toLowerCase()) throw new HttpError("FORBIDDEN", "vendor only", 403);
}

function stripDataUrl(image: string): string {
  const i = image.indexOf("base64,");
  return i >= 0 ? image.slice(i + 7) : image;
}

export async function runScan(body: ScanBody, user: KuraUser, deps: Deps = { recognize: recognizeCard, scryfall: new Scryfall() }) {
  requireVendor(user);
  let recognition: Recognition;
  try {
    recognition = await deps.recognize({ imageBase64: stripDataUrl(body.image), mediaType: body.mediaType, languageHint: body.languageHint });
  } catch (e) {
    if (e instanceof RecognitionUnavailableError) throw new HttpError("RECOGNITION_UNAVAILABLE", e.message, 503);
    throw e;
  }
  const lang = body.languageHint ?? recognition.language ?? "en";
  let candidates: Candidate[] = [];
  try {
    const pinned = await deps.scryfall.named({ name: recognition.name, set: recognition.setHint ?? undefined, lang });
    if (pinned) candidates = [pinned];
    else candidates = (await deps.scryfall.search(`!"${recognition.name}"${lang !== "en" ? ` lang:${lang}` : ""} unique:prints`, 3)).slice(0, 3);
  } catch (e) {
    if (e instanceof ScryfallUnavailableError) throw new HttpError("SCRYFALL_UNAVAILABLE", "Scryfall is rate limiting us, try again in a moment", 503);
    throw e;
  }
  const draftId = crypto.randomUUID();
  await getDb().insert(scanDrafts).values({ id: draftId, vendorWallet: user.wallet, candidates: candidates as CandidateJson[] });
  return { draftId, recognition, candidates };
}
