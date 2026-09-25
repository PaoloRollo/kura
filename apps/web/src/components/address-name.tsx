"use client";

import { EnsName, type EnsNameProps } from "@/components/kura";
import { useDisplayName } from "@/hooks/use-handles";
import { shortAddress } from "@/lib/format";

export type AddressNameProps = Omit<EnsNameProps, "name" | "copyValue"> & {
  address: string;
  /** A name already resolved elsewhere (a typed handle), used while the indexer has none for the address. */
  knownName?: string | null;
};

/** An address shown by its Kura name (handle, `kura.eth`, `vault`...) or its short form; copies the full address. */
export function AddressName({ address, knownName, ...props }: AddressNameProps) {
  const name = useDisplayName(address);
  return <EnsName name={knownName && name === shortAddress(address) ? knownName : name} copyValue={address} {...props} />;
}
