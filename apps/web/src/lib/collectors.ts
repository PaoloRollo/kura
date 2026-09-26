import { eq } from "@ponder/client";
import type { CollectorDirectory } from "@/lib/owner";
import { ponderClient, schema, t, type Row } from "@/lib/ponder";

type Collector = Row<typeof schema.collectors>;

/** The collectors directory, read from the indexer's `collectors` table. */
export const indexerCollectors: CollectorDirectory = {
  byLabel: async (label) => {
    const rows = (await ponderClient.db.select().from(t(schema.collectors)).where(eq(t(schema.collectors.label), label)).limit(1)) as Collector[];
    return rows[0]?.address ?? null;
  },
  byAddress: async (address) => {
    const rows = (await ponderClient.db.select().from(t(schema.collectors)).where(eq(t(schema.collectors.address), address.toLowerCase())).limit(1)) as Collector[];
    return rows[0]?.label ?? null;
  },
};
