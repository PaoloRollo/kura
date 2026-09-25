import "server-only";
import { hashTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { APPRAISAL_TYPES, TICKET_TYPES, bidGateDomain, cardVaultDomain, type Appraisal, type Ticket } from "@kura/shared";
import deployments from "@/generated/deployments.json";

export type TicketDomain = "bidgate" | "vault";

function account() {
  const key = process.env.SIGNER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error("SIGNER_PRIVATE_KEY is not set");
  return privateKeyToAccount(key);
}

function domainFor(d: TicketDomain) {
  return d === "bidgate" ? bidGateDomain(deployments.bidGateHook as Address) : cardVaultDomain(deployments.cardVault as Address);
}

export function signerAddress(): Address {
  return account().address;
}

export function nowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function ticketDigest(t: Ticket, d: TicketDomain): Hex {
  return hashTypedData({ domain: domainFor(d), types: TICKET_TYPES, primaryType: "Ticket", message: t });
}

export function appraisalDigest(a: Appraisal): Hex {
  return hashTypedData({ domain: cardVaultDomain(deployments.cardVault as Address), types: APPRAISAL_TYPES, primaryType: "Appraisal", message: a });
}

export function signTicket(t: Ticket, d: TicketDomain): Promise<Hex> {
  return account().signTypedData({ domain: domainFor(d), types: TICKET_TYPES, primaryType: "Ticket", message: t });
}

export function signAppraisal(a: Appraisal): Promise<Hex> {
  return account().signTypedData({ domain: cardVaultDomain(deployments.cardVault as Address), types: APPRAISAL_TYPES, primaryType: "Appraisal", message: a });
}

export function serializeTicket(t: Ticket) {
  return { kind: t.kind, subject: t.subject, nullifier: t.nullifier.toString(), expiresAt: t.expiresAt.toString() };
}
