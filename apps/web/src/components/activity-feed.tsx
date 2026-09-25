"use client";

import type * as React from "react";
import { useState } from "react";
import {
  AtSignIcon, CheckCheckIcon, ChevronLeftIcon, ChevronRightIcon, CoinsIcon, DownloadIcon, ExternalLinkIcon, FileCode2Icon,
  GavelIcon, KeyRoundIcon, LayersIcon, PackageCheckIcon, ScanLineIcon, SendIcon, Undo2Icon, type LucideIcon,
} from "lucide-react";
import { AddressName } from "@/components/address-name";
import { explorerTx } from "@/lib/chain";
import { ago } from "@/lib/card-view";
import { FEED_FILTERS, FILTER_LABELS, PAGE_SIZES, filterFeed, pageOf, pageWindow, type FeedFilter, type FeedKind, type FeedRow, type Part } from "@/lib/activity-feed";
import { shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";

const ICONS: Record<FeedKind, LucideIcon> = {
  bid: GavelIcon, exit: Undo2Icon, claim: DownloadIcon, settle: CheckCheckIcon, shard: LayersIcon, named: AtSignIcon, mint: ScanLineIcon,
  transfer: SendIcon, shardTransfer: SendIcon, record: FileCode2Icon, redeem: KeyRoundIcon, payout: CoinsIcon, release: PackageCheckIcon,
};

function KindIcon({ kind }: { kind: FeedKind }) {
  const Icon = ICONS[kind];
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-text-2">
      <Icon aria-hidden className="size-4" />
    </span>
  );
}

/** Row text: strings as they are, addresses by their Kura name; parts in `who` are joined with " · ". */
function Parts({ parts, join = "", className }: { parts: Part[]; join?: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1 font-mono text-[12px] text-text-2", className)}>
      {parts.map((p, i) => (
        <span key={i} className="inline-flex min-w-0 items-center gap-x-1">
          {i > 0 && join && <span>{join}</span>}
          {typeof p === "string" ? (
            <span className="whitespace-pre">{p}</span>
          ) : (
            <AddressName address={p.address} avatar={false} copyable={false} maxWidthClassName="max-w-[11rem]" className="[&>span]:text-[12px] [&>span]:text-text-2" />
          )}
        </span>
      ))}
    </span>
  );
}

/** "who" joins its names with " · " except around an arrow part. */
const whoParts = (who: Part[]) => (who.some((p) => typeof p === "string" && p.includes("→")) ? { parts: who, join: "" } : { parts: who, join: "·" });

function TxLink({ hash }: { hash: string | null }) {
  if (!hash) return <span className="text-muted-foreground">·</span>;
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-text">
      {shortHash(hash)}<ExternalLinkIcon aria-hidden className="size-3" />
    </a>
  );
}

/** Overview's Activity list (HisVE): the latest rows, title · who over the detail, with the age. */
export function ActivityList({ rows, now, limit = 6 }: { rows: readonly FeedRow[]; now: number; limit?: number }) {
  if (rows.length === 0) return <p className="text-[13px] text-text-2">No activity yet.</p>;
  return (
    <ul className="flex flex-col">
      {rows.slice(0, limit).map((r) => {
        const w = whoParts(r.who);
        return (
          <li key={r.key} className="flex items-center gap-3 border-b border-border py-3 last:border-0">
            <KindIcon kind={r.kind} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1 text-[13px] text-text">
                {r.title} · <Parts parts={w.parts} join={w.join} className="font-sans text-[13px] text-text [&_span]:font-sans [&_span]:text-[13px] [&_span]:text-text" />
              </span>
              <Parts parts={r.detail} />
            </div>
            <span className="shrink-0 text-[12px] text-muted-foreground">{ago(r.timestamp, now)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The Activity tab (gmKpU): filter pills, one row per event, and client-side pagination with a Rows selector. */
export function ActivityFeed({ rows, now }: { rows: readonly FeedRow[]; now: number }) {
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);
  const shown = filterFeed(rows, filter);
  const p = pageOf(shown, page, size);

  return (
    <div className="flex flex-col gap-5">
      <div role="group" aria-label="Filter events" className="flex flex-wrap gap-2">
        {FEED_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={f === filter}
            onClick={() => { setFilter(f); setPage(1); }}
            className={cn(
              "rounded-full border px-3.5 py-2 text-[12px] leading-none transition-colors",
              f === filter ? "border-text bg-text font-semibold text-bg" : "border-border bg-surface text-text-2 hover:bg-surface-2",
            )}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        {p.total === 0 ? (
          <div className="p-6">
            <h3 className="text-[15px] font-semibold text-text">{filter === "all" ? "No activity yet" : `No ${FILTER_LABELS[filter].toLowerCase()} events yet`}</h3>
            <p className="mt-1 text-[13px] text-text-2">Mints, bids, transfers, settlement and ENS writes for this card show up here as they happen.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <ul className="min-w-[760px]">
              {p.items.map((r) => {
                const w = whoParts(r.who);
                return (
                  <li key={r.key} className="grid grid-cols-[2rem_8.5rem_minmax(0,1.3fr)_minmax(0,1.6fr)_4rem_7rem] items-center gap-4 border-b border-border px-5 py-3.5 last:border-0">
                    <KindIcon kind={r.kind} />
                    <span className="text-[14px] font-semibold text-text">{r.title}</span>
                    <Parts parts={w.parts} join={w.join} />
                    <Parts parts={r.detail} className="text-text" />
                    <span className="text-[12px] text-muted-foreground">{ago(r.timestamp, now)}</span>
                    <span className="text-right"><TxLink hash={r.txHash} /></span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3.5 text-[12px] text-text-2">
          <span>Showing {p.from}–{p.to} of {p.total} events</span>
          <nav aria-label="Pages" className="flex items-center gap-1.5">
            <PageButton label="Previous page" disabled={p.page <= 1} onClick={() => setPage(p.page - 1)}><ChevronLeftIcon className="size-3.5" /></PageButton>
            {pageWindow(p.page, p.pages).map((n, i) =>
              n === "gap" ? <span key={`gap-${i}`} className="px-1 text-muted-foreground">…</span> : (
                <PageButton key={n} label={`Page ${n}`} current={n === p.page} onClick={() => setPage(n)}>{n}</PageButton>
              ),
            )}
            <PageButton label="Next page" disabled={p.page >= p.pages} onClick={() => setPage(p.page + 1)}><ChevronRightIcon className="size-3.5" /></PageButton>
          </nav>
          <label className="flex items-center gap-2">
            Rows
            <select
              value={size}
              onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }}
              className="h-8 rounded-md border border-border bg-bg px-2 font-mono text-[12px] text-text"
            >
              {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </footer>
      </div>
    </div>
  );
}

function PageButton({ children, label, current, disabled, onClick }: { children: React.ReactNode; label: string; current?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={current ? "page" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-md border font-mono text-[12px] transition-colors disabled:opacity-40",
        current ? "border-text bg-text text-bg" : "border-border bg-bg text-text-2 hover:bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}
