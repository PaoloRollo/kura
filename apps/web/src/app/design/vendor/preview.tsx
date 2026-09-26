"use client";

import { useState } from "react";
import Link from "next/link";
import { CircleDollarSignIcon } from "lucide-react";
import { BarChip, TopBar } from "@/components/kura";
import { NAV } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { ReleaseBody, ReleaseShell, StaticConfirm } from "@/components/release-panel";
import { Fees, FeesView, type LedgerEntry } from "@/components/vendor/fees";
import { Inventory, InventoryView, type InventoryItem } from "@/components/vendor/inventory";
import { cardStatusOf } from "@/lib/card-status";
import { usePayoutBalance } from "@/hooks/use-vendor-data";
import { usdc } from "@/lib/format";
import type { ReleaseStage } from "@/lib/release";
import { cn } from "@/lib/utils";
import type { InventoryTab } from "@/lib/vendor";

const A = (n: string) => `0x${n.repeat(40).slice(0, 40)}`;
const ITEMS: InventoryItem[] = [
  { id: 1n, name: "Black Lotus", image: "/cards/black-lotus.webp", set: "LEA", condition: "NM", ensName: "black-lotus-lea-1.kura.eth", state: "whole", owner: A("4f2c"), awaiting: true },
  { id: 2n, name: "Mox Sapphire", image: "/cards/mox-sapphire.webp", set: "LEA", condition: "NM", ensName: "mox-sapphire-lea-2.kura.eth", state: "whole", owner: A("91a0"), awaiting: false },
  { id: 3n, name: "Time Walk", image: "/cards/time-walk.webp", set: "LEA", condition: "LP", ensName: "time-walk-lea-3.kura.eth", state: "sharded", holders: 14, awaiting: false, status: cardStatusOf("sold") },
  { id: 4n, name: "Ancestral Recall", image: "/cards/ancestral-recall.webp", set: "LEA", condition: "LP", ensName: "ancestral-recall-lea-4.kura.eth", state: "auctioning", holders: 3, awaiting: false, status: cardStatusOf("live") },
  { id: 5n, name: "Sol Ring", image: "/cards/sol-ring.webp", set: "LEA", condition: "MP", ensName: "sol-ring-lea-5.kura.eth", state: "released", owner: A("a1b2"), awaiting: false },
];
const STATS = { inCustody: 4, feesTotal: 2_410_500_000n, feesWeek: 412_000_000n, awaiting: 1, released: 1 };

const NOW = Math.floor(Date.UTC(2026, 8, 26, 12) / 1000);
const H = 3600;
const LEDGER: LedgerEntry[] = [
  { id: "1", kind: "buyout", cardId: 1n, name: "Black Lotus", amountUsdc: 128_400_000n, timestamp: NOW - 2 * H },
  { id: "2", kind: "sale", cardId: 1n, name: "Black Lotus", amountUsdc: 171_200_000n, timestamp: NOW - 22 * 60 },
  { id: "3", kind: "sale", cardId: 4n, name: "Ancestral Recall", amountUsdc: 132_400_000n, timestamp: NOW - 26 * H },
  { id: "4", kind: "buyout", cardId: 3n, name: "Time Walk", amountUsdc: 184_000_000n, timestamp: NOW - 30 * H },
  { id: "5", kind: "sale", cardId: 5n, name: "Sol Ring", amountUsdc: 18_600_000n, timestamp: NOW - 50 * H },
  { id: "6", kind: "sale", cardId: 6n, name: "Force of Will", amountUsdc: 4_000_000n, timestamp: NOW - 75 * H },
];
const DAYS = [
  [40, 2], [180, 60], [90, 4], [260, 130], [120, 30], [370, 200], [430, 170],
].map(([sale, buyout], i) => ({ day: `2026-09-${20 + i}`, sale: BigInt(sale) * 1_000_000n, buyout: BigInt(buyout) * 1_000_000n }));

const HOLDER = "0xDeADaD159DF0923dAF871f8B4740eD7f7F417ee9" as const;
const TICKET_TTL = 15 * 60;
const nowSec = () => Math.floor(Date.now() / 1000);
/** The fixture panel stage for a `handover-<stage>` view. */
function fixtureStage(view: string, now: number): ReleaseStage | null {
  const pending = { id: "preview", ticket: { kind: 2, subject: HOLDER, nullifier: "1", expiresAt: String(now + TICKET_TTL - 48) }, signature: "0x" as const, credential: "passport" };
  switch (view) {
    case "handover-waiting": return { kind: "waiting" };
    case "handover-verified": return { kind: "verified", pending, secondsLeft: TICKET_TTL - 48 };
    case "handover-expired": return { kind: "expired" };
    case "handover-released": return { kind: "released", hash: "0x7e1a8c0f6b2d4e9a1c3f5b7d9e0a2c4f6b8d0e1a3c5f7b9d1e3a5c7f9b1d3b9" };
    default: return null;
  }
}

function LiveFeesChip() {
  const b = usePayoutBalance();
  return <BarChip icon={CircleDollarSignIcon} className="hidden lg:inline-flex">Fees {b != null ? usdc(b) : "…"} USDC</BarChip>;
}

export function VendorPreview({ view, views }: { view: string; views: readonly string[] }) {
  const [tab, setTab] = useState<InventoryTab>(view.startsWith("handover") ? "whole" : "all");
  const fees = view.startsWith("fees");
  const stage = fixtureStage(view, nowSec());
  const handoverItems = ITEMS.map((i) => (i.id === 1n ? { ...i, owner: HOLDER, redeemedAt: nowSec() - 12 * 60 } : i));
  return (
    <div className="min-h-screen">
      <TopBar
        nav={NAV.vendor}
        pathname={fees ? "/vendor/fees" : view.startsWith("handover") ? "/vendor/vault?tab=whole" : "/vendor/vault"}
        right={
          <>
            <LiveFeesChip />
            <span className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 font-mono text-[13px] text-text">
              <span aria-hidden className="size-[18px] rounded-full bg-[linear-gradient(-135deg,var(--kura-s7)_15%,var(--kura-shu)_85%)]" />
              0x7aD5…F9fe <span className="hidden text-text-2 sm:inline">· vendor</span>
            </span>
          </>
        }
      />
      <nav aria-label="Preview views" className="flex flex-wrap gap-2 border-b border-border px-4 py-2 lg:px-12" data-preview-nav>
        {views.map((v) => (
          <Link key={v} href={`/design/vendor?view=${v}`} className={cn("rounded-full px-2.5 py-1 text-[12px]", v === view ? "bg-surface-2 text-text" : "text-muted-foreground")}>
            {v}
          </Link>
        ))}
      </nav>
      <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">
        {stage ? (
          <InventoryView
            items={handoverItems}
            stats={STATS}
            tab={tab}
            onTab={setTab}
            initialSelected={1n}
            renderPanel={({ key, cardId, holder, card, redeemedAt, onClose, onShowReleased }) => (
              <ReleaseShell key={key} card={card} onClose={onClose}>
                <ReleaseBody cardId={cardId} card={card} holder={holder} redeemedAt={redeemedAt} stage={stage} now={nowSec()} onClose={onClose} onShowReleased={onShowReleased} confirm={<StaticConfirm enabled={stage.kind === "verified"} />} />
              </ReleaseShell>
            )}
          />
        ) : view === "inventory" || view === "handover" ? (
          <Inventory tab={tab} onTab={setTab} />
        ) : view === "inventory-fixture" ? (
          <InventoryView items={ITEMS} stats={STATS} tab={tab} onTab={setTab} />
        ) : view === "inventory-empty" ? (
          <InventoryView items={[]} stats={{ inCustody: 0, feesTotal: 0n, feesWeek: 0n, awaiting: 0, released: 0 }} tab={tab} onTab={setTab} />
        ) : view === "fees" ? (
          <Fees />
        ) : view === "fees-fixture" ? (
          <FeesView total={2_410_500_000n} payout="0x91a0000000000000000000000000000000077d4" feeBps={250} maxFeeBps={1000} feeAction={<Button variant="secondary" size="compact">Change</Button>} days={DAYS} ledger={LEDGER} now={NOW} />
        ) : (
          <FeesView total={0n} payout="0x7aD58bd97A7cd456dC854B1cEc95eC80f6F4F9fe" feeBps={250} maxFeeBps={1000} feeNote="Set by the vault owner, 0xDeAD…7ee9" feeAction={<Button variant="secondary" size="compact" disabled>Change</Button>} days={DAYS.map((d) => ({ ...d, sale: 0n, buyout: 0n }))} ledger={[]} now={NOW} />
        )}
      </main>
    </div>
  );
}
