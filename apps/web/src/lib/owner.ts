import { getAddress, type Address } from "viem";
import { isValidHandle } from "@kura/shared";
import deployments from "@/generated/deployments.json";

// Assigning a card's owner at the station: scan the owner's QR (an address) or type their Kura handle. Nothing else.

const PARENT = `.${deployments.ensParentLabel}.eth`;

export const OWNER_ERRORS = {
  cardName: "That's a card name, not a collector",
  unknown: "No collector with that handle",
  notHandle: "Enter a Kura handle or scan the owner's QR code",
  unavailable: "Couldn't look the handle up right now. Try again or scan the QR code.",
} as const;

/** Looks collectors up in the indexer's `collectors` table (label ↔ address). */
export type CollectorDirectory = {
  byLabel: (label: string) => Promise<string | null>;
  byAddress: (address: string) => Promise<string | null>;
};

export type ParsedOwner = { kind: "empty" } | { kind: "handle"; label: string } | { kind: "error"; error: string };

/** `kenji` or `kenji.kura.eth` → the handle label. Card labels always contain dashes; any other name or an address is refused. */
export function parseOwnerInput(input: string): ParsedOwner {
  const s = input.trim().toLowerCase();
  if (!s) return { kind: "empty" };
  if (/^0x[0-9a-f]*$/.test(s)) return { kind: "error", error: OWNER_ERRORS.notHandle };
  const label = s.endsWith(PARENT) ? s.slice(0, -PARENT.length) : s;
  if (label.includes(".")) return { kind: "error", error: OWNER_ERRORS.notHandle };
  if (label.includes("-")) return { kind: "error", error: OWNER_ERRORS.cardName };
  return { kind: "handle", label };
}

export type ResolvedOwner = { ok: true; address: Address; name: string } | { ok: false; error: string };

/** Resolves typed owner input to the collector's address and full handle. Never resolves anything but a Kura handle. */
export async function resolveOwner(input: string, directory: CollectorDirectory): Promise<ResolvedOwner | null> {
  const parsed = parseOwnerInput(input);
  if (parsed.kind === "empty") return null;
  if (parsed.kind === "error") return { ok: false, error: parsed.error };
  // A label that can't be a handle can't belong to a collector.
  if (!isValidHandle(parsed.label)) return { ok: false, error: OWNER_ERRORS.unknown };
  let address: string | null;
  try {
    address = await directory.byLabel(parsed.label);
  } catch {
    return { ok: false, error: OWNER_ERRORS.unavailable };
  }
  if (!address) return { ok: false, error: OWNER_ERRORS.unknown };
  return { ok: true, address: getAddress(address), name: `${parsed.label}${PARENT}` };
}

/** The Kura handle of a scanned address ("kenji.kura.eth"), or null when it has none or the lookup fails. */
export async function handleForAddress(address: string, directory: CollectorDirectory): Promise<string | null> {
  try {
    const label = await directory.byAddress(address);
    return label ? `${label}${PARENT}` : null;
  } catch {
    return null;
  }
}
