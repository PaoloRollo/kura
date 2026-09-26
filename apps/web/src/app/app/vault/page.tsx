"use client";

import { desc, eq } from "@ponder/client";
import { usePonderQuery } from "@ponder/react";
import { VaultView, type ReleasedCard } from "@/components/vault-view";
import { useVaultFeeBps } from "@/hooks/use-vault-fee";
import { identities, useAttributes } from "@/hooks/use-explore";
import { useFeeEvents, useVaultCards } from "@/hooks/use-vendor-data";
import { addresses } from "@/lib/chain";
import { schema, t, type Row } from "@/lib/ponder";

type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];
type Activity = Row<typeof schema.activities>;
const releasesQuery = (db: Db) =>
  db.select().from(t(schema.activities)).where(eq(t(schema.activities.kind), "release"))
    .orderBy(desc(t(schema.activities.blockNumber)), desc(t(schema.activities.logIndex))) as Promise<Activity[]>;

/** Collector · Vault (Pu0g5), live. */
export default function VaultPage() {
  const cards = useVaultCards();
  const fees = useFeeEvents();
  const releases = usePonderQuery({ queryFn: releasesQuery });
  const feeBps = useVaultFeeBps();
  const rows = cards.data ?? [];
  const releasedRows = rows.filter((c) => c.state === "released");
  // Names and art in one attributes request, not one /api/meta call per card.
  const idents = identities(releasedRows, useAttributes(releasedRows.map((c) => c.scryfallId)));
  const at = new Map((releases.data ?? []).map((a) => [String(a.cardId), a.timestamp]));
  const released: ReleasedCard[] = releasedRows
    .map((c) => {
      const m = idents.get(c.id.toString());
      return { id: c.id, name: m?.name ?? c.label, image: m?.image || null, to: c.ownerOf, releasedAt: at.get(c.id.toString()) ?? null };
    })
    .sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0));
  return (
    <VaultView
      parentName={`${addresses.ensParentLabel}.eth`}
      feeBps={feeBps}
      cardsHeld={rows.length - releasedRows.length}
      feesEarned={(fees.data ?? []).reduce((a, f) => a + f.amountUsdc, 0n)}
      released={released}
      isLoading={cards.isLoading || fees.isLoading}
    />
  );
}
