import { z } from "zod";
import type { Address } from "viem";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s as Address);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const DeploymentsSchema = z.object({
  chainId: z.number().int(),
  deployBlock: z.number().int().nonnegative(),
  cardVault: address,
  bidGateHook: address,
  cardNames: address,
  usdc: address,
  permit2: address,
  ccaFactory: address,
  ensRegistry: address,
  ensResolver: address,
  ensParentLabel: z.string(),
  ensParentNode: bytes32,
  signer: address,
  vendor: address,
  shardMarket: address,
  poolManager: address,
  positionManager: address,
  universalRouter: address,
  stateView: address,
  v4Quoter: address,
});

export type Deployments = z.infer<typeof DeploymentsSchema>;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export function isDeployed(d: Deployments): boolean {
  return d.cardVault !== ZERO_ADDRESS;
}
