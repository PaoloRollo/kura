import "server-only";
import deployments from "@/generated/deployments.json";
import type { KuraUser } from "@/lib/auth";
import { HttpError } from "@/lib/http";

export function requireVendor(user: KuraUser) {
  if (user.wallet.toLowerCase() !== deployments.vendor.toLowerCase()) throw new HttpError("FORBIDDEN", "vendor only", 403);
}
