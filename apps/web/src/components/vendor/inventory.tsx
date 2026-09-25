"use client";

import { useState } from "react";
import Link from "next/link";
import { PackageOpenIcon, ScanLineIcon } from "lucide-react";
import { AddressName } from "@/components/address-name";
import { CardArt, Pill, SearchInput, StatTile, type PillTone } from "@/components/kura";
import { ReleasePanel } from "@/components/release-panel";
import { IndexerLoading } from "@/components/sync-state";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";
import { useCardMetas, useFeeEvents, useShardBalances, useShardings, useVaultCards } from "@/hooks/use-vendor-data";
import { addresses } from "@/lib/chain";
import { money } from "@/lib/format";
import { metaCardName, metaTrait } from "@/lib/meta";
import { cn } from "@/lib/utils";
import {
  INVENTORY_TABS,
  awaitingHandover,
  feeTotals,
  holderCounts,
  inTab,
  matchesSearch,
  tabCounts,
  type CardState,
  type InventoryTab,
} from "@/lib/vendor";

export type InventoryItem = {
  id: bigint;
  /** Card name and art, from /api/meta/[id]; missing while it loads. */
  name?: string;
  image?: string;
  set: string;
  condition: string;
  ensName: string;
  state: CardState;
  /** The NFT holder (whole cards) or the beneficial owner (released). */
  owner?: string;
  /** Shard holders, for cards on auction or sharded. */
  holders?: number;
  awaiting: boolean;
};

export type InventoryStats = { inCustody: number; feesTotal: bigint; feesWeek: bigint; awaiting: number; released: number };

const PILL: Record<CardState, { tone: PillTone; label: string }> = {
  whole: { tone: "neutral", label: "whole" },
  auctioning: { tone: "live", label: "auction" },
  sharded: { tone: "sharded", label: "sharded" },
  released: { tone: "released", label: "released" },
};

const EMPTY_TAB: Record<InventoryTab, string> = {
  all: "No cards in the vault yet",
  whole: "No whole cards in the vault",
  sharded: "No cards on auction or sharded",
  released: "No cards released yet",
};

function Row({ item, selected, onHandOver }: { item: InventoryItem; selected: boolean; onHandOver: () => void }) {
  const pill = PILL[item.state];
  const released = item.state === "released";
  return (
    <tr className={cn("border-t border-border", selected && "bg-kin-soft/40")} aria-selected={selected || undefined}>
      <td className="py-3.5 pr-4 pl-5">
        <Link href={`/app/cards/${item.id}`} className="flex items-center gap-3.5 outline-none hover:[&_.name]:underline focus-visible:ring-2 focus-visible:ring-ring/50">
          {item.image ? (
            <CardArt src={item.image} alt="" className="h-[40px] w-[29px] shrink-0 rounded-[2px] shadow-none" />
          ) : (
            <span aria-hidden className="h-[40px] w-[29px] shrink-0 animate-pulse rounded-[2px] bg-surface-2" />
          )}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="name truncate text-[14px] font-medium text-text">{item.name ?? `Card #${item.id}`}</span>
            <span className="text-[11px] text-text-2">
              {item.set} · {item.condition}
            </span>
          </span>
        </Link>
      </td>
      <td className="py-3.5 pr-4">
        <span className={cn("font-mono text-[12px]", released ? "text-muted-foreground" : "text-kin")}>{item.ensName}</span>
      </td>
      <td className="py-3.5 pr-4">
        <Pill tone={pill.tone} dot={false} className="font-medium">
          {pill.label}
        </Pill>
      </td>
      <td className="py-3.5 pr-4 font-mono text-[12px] text-text-2">
        {item.holders != null ? (
          `${item.holders} ${item.holders === 1 ? "holder" : "holders"}`
        ) : item.owner ? (
          <AddressName address={item.owner} avatar={false} copyable={false} className="[&>span]:text-[12px] [&>span]:text-text-2" />
        ) : (
          "—"
        )}
      </td>
      <td className="py-3.5 pr-5 text-right">
        {item.state === "whole" && (
          <Button variant={selected || item.awaiting ? "redeem" : "secondary"} size="compact" onClick={onHandOver} aria-pressed={selected}>
            <PackageOpenIcon />Hand over
          </Button>
        )}
      </td>
    </tr>
  );
}

/** Vendor · Inventory & handover (tM3Hy): stat tiles, tabs, search and the card table. Presentational. */
export function InventoryView({
  items,
  stats,
  tab,
  onTab,
}: {
  items: InventoryItem[];
  stats: InventoryStats;
  tab: InventoryTab;
  onTab: (tab: InventoryTab) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const counts = tabCounts(items);
  const shown = items.filter((i) => inTab(i.state, tab) && matchesSearch({ name: i.name, ensName: i.ensName, owner: i.owner }, query));
  const selected = items.find((i) => i.id === selectedId && i.state === "whole") ?? null;

  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)] items-start gap-6", selected && "xl:grid-cols-[minmax(0,1fr)_400px]")}>
      <div className="flex min-w-0 flex-col gap-5">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="In custody" value={stats.inCustody} sub="in the vault now" />
          <StatTile label="Fees earned" value={<span className="text-kin">{money(stats.feesTotal)}</span>} sub={`this week ${money(stats.feesWeek, 0)}`} />
          <StatTile label="Awaiting handover" value={<span className={stats.awaiting ? "text-shu" : undefined}>{stats.awaiting}</span>} sub="Passport check needed" />
          <StatTile label="Released" value={stats.released} sub="names revoked" />
        </div>

        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div role="tablist" aria-label="Filter cards" className="flex flex-wrap gap-1">
              {INVENTORY_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => onTab(t.id)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    tab === t.id ? "bg-surface-2 font-semibold text-text" : "text-text-2 hover:text-text",
                  )}
                >
                  {t.label} {counts[t.id]}
                </button>
              ))}
            </div>
            <SearchInput
              aria-label="Search by card name, ENS name or owner"
              placeholder="Search name, ENS or owner"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              boxClassName="h-10 py-0 sm:w-[260px] bg-bg"
            />
          </div>

          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 border-t border-border px-5 py-16 text-center">
              <p className="text-[15px] font-semibold text-text">No cards in the vault yet</p>
              <Button asChild variant="primary" size="compact">
                <Link href="/vendor/scan"><ScanLineIcon />Scan a card</Link>
              </Button>
            </div>
          ) : shown.length === 0 ? (
            <p className="border-t border-border px-5 py-12 text-center text-[14px] text-text-2">
              {query.trim() ? `No cards match "${query.trim()}"` : EMPTY_TAB[tab]}
            </p>
          ) : (
            // No 390 design for vendor screens: the table scrolls sideways on narrow screens.
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left">
                <thead>
                  <tr className="border-t border-border text-[12px] text-muted-foreground">
                    <th className="py-3 pr-4 pl-5 font-normal">Card</th>
                    <th className="py-3 pr-4 font-normal">ENS name</th>
                    <th className="py-3 pr-4 font-normal">State</th>
                    <th className="py-3 pr-4 font-normal">Owner</th>
                    <th className="py-3 pr-5 font-normal"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item) => (
                    <Row
                      key={item.id.toString()}
                      item={item}
                      selected={selected?.id === item.id}
                      onHandOver={() => setSelectedId((id) => (id === item.id ? null : item.id))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {selected && (
        <ReleasePanel cardId={selected.id} name={selected.name ?? `card #${selected.id}`} holder={selected.owner ?? ""} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

/** The set code in a card label ("black-lotus-lea-1" -> "LEA"). */
const labelSet = (label: string) => (label.split("-").at(-2) ?? "").toUpperCase();

/** The inventory, live from the indexer. */
export function Inventory({ tab, onTab }: { tab: InventoryTab; onTab: (tab: InventoryTab) => void }) {
  const cards = useVaultCards();
  const fees = useFeeEvents();
  const shardings = useShardings();
  const balances = useShardBalances();
  const now = useNow();
  const metas = useCardMetas((cards.data ?? []).map((c) => c.id));

  if (cards.error) return <p className="py-12 text-center text-[14px] text-text-2">The indexer can&apos;t be reached right now. Try again in a moment.</p>;
  if (!cards.data) return <IndexerLoading title="Loading the vault" className="mx-auto w-full max-w-md" />;

  const holders = holderCounts(cards.data, balances.data ?? [], addresses.cardVault);
  const awaiting = awaitingHandover(cards.data, shardings.data ?? []);
  const items: InventoryItem[] = cards.data.map((c) => {
    const meta = metas.get(c.id);
    const shardedState = c.state === "auctioning" || c.state === "sharded";
    return {
      id: c.id,
      name: meta ? metaCardName(meta.name) : undefined,
      image: meta?.image,
      set: (meta && metaTrait(meta, "Set")) || labelSet(c.label),
      condition: c.condition,
      ensName: c.ensName,
      state: c.state,
      owner: shardedState ? undefined : c.state === "released" ? c.beneficialOwner : c.ownerOf,
      holders: shardedState ? (holders.get(c.id) ?? 0) : undefined,
      awaiting: awaiting.has(c.id),
    };
  });
  const totals = feeTotals(fees.data ?? [], now);
  const stats: InventoryStats = {
    inCustody: items.filter((i) => i.state !== "released").length,
    feesTotal: totals.total,
    feesWeek: totals.week,
    awaiting: awaiting.size,
    released: items.filter((i) => i.state === "released").length,
  };
  return <InventoryView items={items} stats={stats} tab={tab} onTab={onTab} />;
}
