"use client";

import Link from "next/link";
import { CheckCheckIcon, CoinsIcon, ExternalLinkIcon, KeyRoundIcon, ScanLineIcon, XIcon, type LucideIcon } from "lucide-react";
import { ChartFrame } from "@/components/charts/chart-frame";
import { ago } from "@/lib/card-view";
import { explorerTx } from "@/lib/chain";
import { money, shortHash } from "@/lib/format";
import type { MultibaasCoverage, MultibaasRecent, RecentEvent } from "@/lib/multibaas/recent";

/** The recent-events panel's input: MultiBaas's events, card names by id (the indexer's), and the clock for ages. */
export type RecentPanel = { recent: MultibaasRecent; names: ReadonlyMap<string, string>; now: number };

const utc = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "Sep 26, 09:02 UTC". */
export const utcTime = (t: number) => `${utc.format(new Date(t * 1000))} UTC`;

/** "since Sep 26, 09:02 UTC", or "since the vault's deployment" when MultiBaas reaches back that far. */
export const sinceLabel = (c: MultibaasCoverage) => (c.fromDeploy ? "since the vault's deployment" : `since ${utcTime(c.since)}`);

type Shown = { title: string; detail: string; icon: LucideIcon };
function shown(e: RecentEvent): Shown {
  const amount = e.amount == null ? "" : money(e.amount, 2);
  switch (e.kind) {
    case "mint":
      return { title: "Minted", detail: `card #${e.card}`, icon: ScanLineIcon };
    case "settle":
      return e.graduated ? { title: "Auction settled", detail: `${amount} raised`, icon: CheckCheckIcon } : { title: "Reserve not met", detail: "no sale · bids refunded", icon: XIcon };
    case "redeem":
      return { title: "Bought out", detail: `${amount} payout`, icon: KeyRoundIcon };
    case "fee":
      return { title: "Fee to vault", detail: `${amount} · ${e.feeKind === "buyout" ? "buyout" : "sale"}`, icon: CoinsIcon };
  }
}

function EventRow({ e, name, now }: { e: RecentEvent; name: string; now: number }) {
  const s = shown(e);
  const Icon = s.icon;
  return (
    <li className="flex items-center gap-3 border-b border-border py-3 last:border-0">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-text-2">
        <Icon aria-hidden className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1 text-[13px] text-text">
          <span className="shrink-0">{s.title} ·</span>
          <Link href={`/app/cards/${e.card}`} className="min-w-0 truncate hover:underline">{name}</Link>
        </span>
        <span className="flex min-w-0 items-center gap-2 font-mono text-[12px] text-text-2">
          <span className="min-w-0 truncate">{s.detail}</span>
          <a href={explorerTx(e.tx)} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-text">
            {shortHash(e.tx)}<ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        </span>
      </div>
      <span className="shrink-0 text-[12px] text-muted-foreground" title={utcTime(e.at)}>{ago(e.at, now)}</span>
    </li>
  );
}

/**
 * "Recent vault events · via MultiBaas": the newest CardVault events MultiBaas holds (mints, settles, buyouts, fees),
 * in the Activity list's row style (HisVE), with since when MultiBaas indexes the vault. Shown from the moment the vault
 * is linked, whatever the 24h tiles read; the dashboard leaves it out while MultiBaas is unavailable.
 */
export function RecentVaultEvents({ recent, names, now }: RecentPanel) {
  const { events, coverage } = recent;
  const nameOf = (e: RecentEvent) => names.get(e.card.toString()) ?? `Card #${e.card}`;
  const since = sinceLabel(coverage);
  const table = {
    columns: ["Event", "Card", "Detail", "When", "Tx"],
    rows: events.map((e) => {
      const s = shown(e);
      return [s.title, nameOf(e), s.detail, utcTime(e.at), shortHash(e.tx)];
    }),
  };
  return (
    <ChartFrame
      title="Recent vault events · via MultiBaas"
      subtitle="Mints, settles, buyouts and fees from MultiBaas's saved Event Queries, newest first"
      table={events.length > 0 ? table : { columns: ["Recent vault events"], rows: [[`No vault events indexed by MultiBaas yet · ${since}`]] }}
      footer={events.length > 0 ? <span title={`MultiBaas indexes the vault from block ${coverage.startBlock.toLocaleString("en-US")}`}>Indexed by MultiBaas {since} · {recent.total} event{recent.total === 1 ? "" : "s"} held</span> : undefined}
    >
      {events.length === 0 ? (
        <p className="py-8 text-center text-[12px] text-muted-foreground" title={`MultiBaas indexes the vault from block ${coverage.startBlock.toLocaleString("en-US")}`}>
          No vault events indexed by MultiBaas yet · {since}
        </p>
      ) : (
        // Two columns on wide screens, each read top to bottom (newest first down the left, then the right); stacked
        // in the same order on phones.
        <div className="grid lg:grid-cols-2 lg:gap-x-8">
          {[events.slice(0, Math.ceil(events.length / 2)), events.slice(Math.ceil(events.length / 2))].map((col, i) => col.length > 0 && (
            <ul key={i} className="flex flex-col max-lg:[&:not(:last-child)>li:last-child]:border-b">
              {col.map((e) => <EventRow key={`${e.tx}-${e.kind}-${e.card}`} e={e} name={nameOf(e)} now={now} />)}
            </ul>
          ))}
        </div>
      )}
    </ChartFrame>
  );
}
