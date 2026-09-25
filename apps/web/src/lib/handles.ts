import { isAddress, keccak256, toBytes, type Address } from "viem";
import { RESERVED_HANDLES } from "@kura/shared";
import { shortAddress } from "@/lib/format";

// Collector handles (`<label>.kura.eth`): the availability check and the names addresses are shown by.
// No React and no chain client here, so node tests and the API route share it.

export type HandleReason = "INVALID" | "RESERVED" | "TAKEN" | "ALREADY_NAMED";
export type Availability = { available: true } | { available: false; reason: HandleReason; label?: string };

/** The on-chain reads behind a check (CardNames `reserved`, `isAvailable`, `collectorLabels`). */
export type HandleReader = {
  reserved: (labelHash: `0x${string}`) => Promise<boolean>;
  isAvailable: (label: string) => Promise<boolean>;
  collectorLabel: (address: Address) => Promise<string>;
};

const HANDLE_RE = /^[a-z0-9]{3,32}$/;

/** Lowercased and trimmed, the way the input and the route read a typed handle. */
export const normalizeHandle = (s: string) => s.trim().toLowerCase();

/**
 * Checks a handle in the order `CardNames.registerCollector` reverts: InvalidHandle, HandleReserved (the on-chain set,
 * plus the shared list), HandleTaken, then AlreadyNamed when `address` already holds a handle.
 */
export async function checkHandle(raw: string, reader: HandleReader, address?: Address): Promise<Availability> {
  const label = normalizeHandle(raw);
  if (!HANDLE_RE.test(label)) return { available: false, reason: "INVALID" };
  if ((RESERVED_HANDLES as readonly string[]).includes(label)) return { available: false, reason: "RESERVED" };
  const [reserved, available, current] = await Promise.all([
    reader.reserved(keccak256(toBytes(label))),
    reader.isAvailable(label),
    address ? reader.collectorLabel(address) : Promise.resolve(""),
  ]);
  if (reserved) return { available: false, reason: "RESERVED" };
  if (!available) return { available: false, reason: "TAKEN" };
  if (current) return { available: false, reason: "ALREADY_NAMED", label: current };
  return { available: true };
}

export const HANDLE_RULE = "3 to 32 lowercase letters or digits, no dashes";

/** The line under the handle field for each outcome. */
export function handleMessage(a: Availability | { checking: true }, label: string, parent: string): string {
  if ("checking" in a) return "Checking…";
  if (a.available) return `Available · ${HANDLE_RULE}`;
  switch (a.reason) {
    case "INVALID":
      return HANDLE_RULE;
    case "RESERVED":
      return `${label} is reserved`;
    case "TAKEN":
      return `${label}.${parent} is taken`;
    case "ALREADY_NAMED":
      return `This wallet already has ${a.label ? `${a.label}.${parent}` : "a handle"}. One per wallet.`;
  }
}

const REVERT_REASONS: Record<string, HandleReason> = {
  InvalidHandle: "INVALID",
  HandleReserved: "RESERVED",
  HandleTaken: "TAKEN",
  AlreadyNamed: "ALREADY_NAMED",
};

/** The availability reason behind a `registerCollector` revert name, or null for any other failure. */
export function reasonFromRevert(name: string | null | undefined): HandleReason | null {
  return (name && REVERT_REASONS[name]) || null;
}

export type NameParties = { vendor: string; signer: string; cardVault: string; cardNames: string; ensParentLabel: string };

/** address(lowercase) → collector label. */
export type Handles = Record<string, string>;

/**
 * The name an address is shown by: the vendor as `kura.eth`, the appraiser (the signer) as `appraiser.kura.eth`, the
 * vault contracts as `vault`, a collector as `<label>.kura.eth`, anything else as its short address.
 */
export function displayName(address: string, handles: Handles, parties: NameParties): string {
  const a = address.toLowerCase();
  const parent = `${parties.ensParentLabel}.eth`;
  if (a === parties.vendor.toLowerCase()) return parent;
  if (a === parties.signer.toLowerCase()) return `appraiser.${parent}`;
  if (a === parties.cardVault.toLowerCase() || a === parties.cardNames.toLowerCase()) return "vault";
  const label = handles[a];
  if (label && label !== "vendor") return `${label}.${parent}`;
  return isAddress(address, { strict: false }) ? shortAddress(address) : address;
}
