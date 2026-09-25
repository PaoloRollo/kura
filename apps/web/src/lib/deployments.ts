import "server-only";
import { DeploymentsSchema, isDeployed, type Deployments } from "@kura/shared";
import committed from "@/generated/deployments.json";
import { HttpError } from "@/lib/http";

const fromFile: Deployments = DeploymentsSchema.parse(committed);
let current: Deployments = fromFile;

/** The contract addresses the server signs and gates against. */
export function deployments(): Deployments {
  return current;
}

/** The deployments, or a CONFIG error while the zero-address placeholder is still in place. */
export function requireDeployed(): Deployments {
  if (!isDeployed(current)) throw new HttpError("CONFIG", "contracts are not deployed; run pnpm sync:deployments", 500);
  return current;
}

/** Tests swap in other deployments (a placeholder, or a test signer). */
export function setDeploymentsForTests(d: Deployments) {
  current = d;
}

export function resetDeploymentsForTests() {
  current = fromFile;
}
