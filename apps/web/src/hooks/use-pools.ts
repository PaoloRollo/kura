"use client";

import { usePonderQuery } from "@ponder/react";
import type { PoolRow } from "@/lib/market";
import { schema, t } from "@/lib/ponder";

type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];

// Module level: usePonderQuery re-subscribes whenever the query function changes. One row per settled, graduated card.
const poolsQuery = (db: Db) => db.select().from(t(schema.pools)) as Promise<PoolRow[]>;

/** Every card's Uniswap pool row (price, frozen), for valuing holdings at the pool price. Empty while loading. */
export function usePools(): PoolRow[] {
  return usePonderQuery({ queryFn: poolsQuery }).data ?? [];
}
