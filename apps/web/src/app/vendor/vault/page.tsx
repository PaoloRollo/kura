"use client";

import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { IndexerLoading } from "@/components/sync-state";
import { Inventory } from "@/components/vendor/inventory";
import { INVENTORY_TABS, type InventoryTab } from "@/lib/vendor";

function VaultInventory() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = params.get("tab");
  const tab: InventoryTab = INVENTORY_TABS.some((t) => t.id === raw) ? (raw as InventoryTab) : "all";
  // The tab lives in the URL: the nav's Handover link is this page on ?tab=whole.
  const onTab = (t: InventoryTab) => router.replace(t === "all" ? pathname : `${pathname}?tab=${t}`, { scroll: false });
  return <Inventory tab={tab} onTab={onTab} />;
}

/** Vendor · Inventory & handover (tM3Hy). */
export default function VaultPage() {
  return (
    <Suspense fallback={<IndexerLoading title="Loading the vault" className="mx-auto w-full max-w-md" />}>
      <VaultInventory />
    </Suspense>
  );
}
