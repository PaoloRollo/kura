import { NextResponse } from "next/server";
import { deployments } from "@/lib/deployments";
import { jsonError } from "@/lib/http";
import { claimDelivery, finishDelivery } from "@/lib/multibaas/deliveries";
import { invalidateMultibaasFigures } from "@/lib/multibaas/server";
import { WebhookBody, processDeliveries, verifyMultibaasSignature } from "@/lib/multibaas/webhook";
import { publishSettledAppraisal } from "@/lib/settled-appraisal";

// Up to MAX_APPRAISALS_PER_REQUEST ENS writes, each awaited up to ENS_WRITE_TIMEOUT_MS.
export const maxDuration = 60;

/**
 * MultiBaas webhook (`kura_web`, event.emitted). Verifies X-MultiBaas-Signature over the raw body and timestamp with
 * MULTIBAAS_WEBHOOK_SECRET (401 otherwise; 503 while the secret is unset, so MultiBaas keeps retrying), then
 * lib/multibaas/webhook's processDeliveries: a graduated AuctionSettled publishes the card's ENS appraisal at once, and
 * any CardVault event drops the dashboard's memoised MultiBaas figures. 200 with each delivery's outcome, or 503 with
 * them when one must be retried.
 */
export async function POST(req: Request) {
  const secret = process.env.MULTIBAAS_WEBHOOK_SECRET;
  if (!secret) {
    console.error("multibaas webhook: MULTIBAAS_WEBHOOK_SECRET is not set; refusing the delivery (MultiBaas will retry)");
    return jsonError("UNCONFIGURED", "webhook secret not configured", 503);
  }
  const body = new Uint8Array(await req.arrayBuffer());
  const check = verifyMultibaasSignature({
    body,
    signature: req.headers.get("x-multibaas-signature"),
    timestamp: req.headers.get("x-multibaas-timestamp"),
    secret,
    now: Math.floor(Date.now() / 1000),
  });
  if (check !== "ok") {
    console.warn(`multibaas webhook: refused a delivery (${check})`);
    return jsonError("UNAUTHENTICATED", "bad or missing signature", 401);
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return jsonError("BAD_REQUEST", "body must be JSON", 400);
  }
  const parsed = WebhookBody.safeParse(json);
  if (!parsed.success) return jsonError("BAD_REQUEST", "body must be a MultiBaas delivery array", 400);
  const { results, retry } = await processDeliveries(parsed.data, {
    vault: deployments().cardVault,
    claim: claimDelivery,
    finish: finishDelivery,
    publish: (cardId) => publishSettledAppraisal(cardId),
    invalidate: invalidateMultibaasFigures,
  });
  return NextResponse.json({ results }, { status: retry ? 503 : 200 });
}
