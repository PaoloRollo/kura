import type { Address, TypedDataDomain } from "viem";

export const SEPOLIA_CHAIN_ID = 11155111;

export const TicketKind = { HUMAN: 1, PASSPORT: 2 } as const;
export type TicketKindValue = (typeof TicketKind)[keyof typeof TicketKind];

export const TTL = { bidTicketSec: 24 * 60 * 60, releaseTicketSec: 15 * 60, appraisalSec: 10 * 60 } as const;

export const TICKET_TYPES = {
  Ticket: [
    { name: "kind", type: "uint8" },
    { name: "subject", type: "address" },
    { name: "nullifier", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const APPRAISAL_TYPES = {
  Appraisal: [
    { name: "cardId", type: "uint256" },
    { name: "shardToken", type: "address" },
    { name: "usdcPerShard", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export type Ticket = { kind: TicketKindValue; subject: Address; nullifier: bigint; expiresAt: bigint };
export type Appraisal = { cardId: bigint; shardToken: Address; usdcPerShard: bigint; expiresAt: bigint };

export function bidGateDomain(hook: Address): TypedDataDomain {
  return { name: "Kura BidGate", version: "1", chainId: SEPOLIA_CHAIN_ID, verifyingContract: hook };
}

export function cardVaultDomain(vault: Address): TypedDataDomain {
  return { name: "Kura CardVault", version: "1", chainId: SEPOLIA_CHAIN_ID, verifyingContract: vault };
}
