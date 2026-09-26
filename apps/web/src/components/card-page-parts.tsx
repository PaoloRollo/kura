"use client";

import Link from "next/link";
import type { Identity } from "@/components/card-header";
import { MobileNav } from "@/components/mobile-nav";
import { IndexerLoading } from "@/components/sync-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { CardData } from "@/hooks/use-card";
import { metaCardName, metaTrait } from "@/lib/meta";

// The card page's light pieces, apart from card-page-view so the redeem, shard and portfolio pages don't pull in the
// whole card page (and its Analytics tab's charts).

/** Name, art, set and rarity from metadata and attributes, whichever has loaded. */
export function identityOf(c: CardData): Identity {
  return {
    name: c.meta ? metaCardName(c.meta.name) : c.card ? c.card.label : "…",
    image: c.meta?.image || null,
    set: c.attributes?.set ?? (c.meta ? metaTrait(c.meta, "Set") : undefined),
    rarity: c.attributes?.rarity ?? (c.meta ? metaTrait(c.meta, "Rarity") : undefined),
    artist: c.attributes?.artist ?? null,
  };
}

export function CardLoading() {
  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[420px_minmax(0,1fr)]">
      <MobileNav className="-mt-2 -mb-6" />
      <Skeleton className="mx-auto aspect-[63/88] w-full max-w-[280px] rounded-3xl bg-surface lg:max-w-none" />
      <div className="flex min-w-0 flex-col gap-4">
        <Skeleton className="h-6 w-60 bg-surface" />
        <Skeleton className="h-14 w-96 max-w-full bg-surface" />
        <IndexerLoading title="Loading this card" className="max-w-md" />
      </div>
    </div>
  );
}

export function CardNotFound({ id }: { id: string }) {
  return (
    <div className="flex flex-col gap-4">
      <MobileNav className="-mt-2" />
      <div className="flex flex-col items-start gap-2 rounded-3xl border border-border bg-surface p-6">
        <h1 className="font-display text-[24px] font-semibold text-text">Card not found</h1>
        <p className="text-[14px] text-text-2">No vault card has id {id}. It may not be minted yet, or the indexer is still catching up.</p>
        <Link href="/app" className="text-[13px] text-text underline-offset-2 hover:underline">Back to explore</Link>
      </div>
    </div>
  );
}
