"use client";

import { EnsName, type EnsNameProps } from "@/components/kura";
import { shortAddress } from "@/lib/format";

export type AddressNameProps = Omit<EnsNameProps, "name" | "copyValue"> & { address: string };

/**
 * An address shown by its name. Stub until Task 3 resolves collector handles: renders the short address, copying the
 * full one.
 */
export function AddressName({ address, ...props }: AddressNameProps) {
  return <EnsName name={shortAddress(address)} copyValue={address} {...props} />;
}
