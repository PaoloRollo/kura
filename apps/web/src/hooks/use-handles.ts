"use client";

import { usePonderQuery } from "@ponder/react";
import { addresses } from "@/lib/chain";
import { displayName, type Handles } from "@/lib/handles";
import { schema, t, type Row } from "@/lib/ponder";

type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];
type Collector = Row<typeof schema.collectors>;
// Module level: usePonderQuery re-subscribes whenever the query function changes.
const collectorsQuery = (db: Db) => db.select().from(t(schema.collectors)) as Promise<Collector[]>;

/** Every collector handle, address(lowercase) → label, plus the vendor as "vendor"; `ready` once the table loaded. Live. */
export function useHandlesState(): { handles: Handles; ready: boolean } {
  const { data, isSuccess } = usePonderQuery({ queryFn: collectorsQuery });
  const handles: Handles = { [addresses.vendor.toLowerCase()]: "vendor" };
  for (const c of data ?? []) handles[c.address.toLowerCase()] = c.label;
  return { handles, ready: isSuccess };
}

/** Every collector handle, address(lowercase) → label, plus the vendor as "vendor". Live. */
export const useHandles = (): Handles => useHandlesState().handles;

/** The name `address` is shown by (see `displayName` in lib/handles). */
export function useDisplayName(address: string | null | undefined): string {
  const handles = useHandles();
  return address ? displayName(address, handles, addresses) : "";
}

export { displayName };
