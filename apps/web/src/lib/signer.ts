import "server-only";
import { hashTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { APPRAISAL_TYPES, TICKET_TYPES, bidGateDomain, cardVaultDomain, type Appraisal, type Ticket } from "@kura/shared";
import { deployments, requireDeployed } from "@/lib/deployments";
import { HttpError } from "@/lib/http";

export type TicketDomain = "bidgate" | "vault";

function account() {
  const key = process.env.SIGNER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error("SIGNER_PRIVATE_KEY is not set");
  return privateKeyToAccount(key);
}

/** The signing account, once the contracts are deployed and the key is the one they trust. */
function deployedSigner() {
  const d = requireDeployed();
  const signer = account();
  if (signer.address.toLowerCase() !== d.signer.toLowerCase()) {
    throw new HttpError("CONFIG", `SIGNER_PRIVATE_KEY is for ${signer.address}, but the contracts trust ${d.signer}`, 500);
  }
  return signer;
}

function domainFor(d: TicketDomain) {
  const { bidGateHook, cardVault } = deployments();
  return d === "bidgate" ? bidGateDomain(bidGateHook) : cardVaultDomain(cardVault);
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
  return hashTypedData({ domain: cardVaultDomain(deployments().cardVault), types: APPRAISAL_TYPES, primaryType: "Appraisal", message: a });
}

export async function signTicket(t: Ticket, d: TicketDomain): Promise<Hex> {
  return deployedSigner().signTypedData({ domain: domainFor(d), types: TICKET_TYPES, primaryType: "Ticket", message: t });
}

export async function signAppraisal(a: Appraisal): Promise<Hex> {
  return deployedSigner().signTypedData({ domain: cardVaultDomain(deployments().cardVault), types: APPRAISAL_TYPES, primaryType: "Appraisal", message: a });
}

export function serializeTicket(t: Ticket) {
  return { kind: t.kind, subject: t.subject, nullifier: t.nullifier.toString(), expiresAt: t.expiresAt.toString() };
}
