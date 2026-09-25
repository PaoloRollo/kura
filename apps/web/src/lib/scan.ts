import "server-only";
import type { KuraUser } from "@/lib/auth";
import { requireDeployed } from "@/lib/deployments";
import { HttpError } from "@/lib/http";

export function requireVendor(user: KuraUser) {
  const { vendor } = requireDeployed();
  if (user.wallet.toLowerCase() !== vendor.toLowerCase()) throw new HttpError("FORBIDDEN", "vendor only", 403);
}
