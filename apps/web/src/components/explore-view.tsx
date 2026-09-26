"use client";

import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpDownIcon, ChevronDownIcon, CompassIcon, LayoutGridIcon, ListIcon, SearchXIcon, SlidersHorizontalIcon, TimerIcon } from "lucide-react";
import { AddressName } from "@/components/address-name";
import { AuctionCard, Button, CardArt, FilterChip, SearchInput } from "@/components/kura";
import { cardStatusOf } from "@/lib/card-status";
import { MobilePageTitle } from "@/components/page-title";
import { IndexerLoading } from "@/components/sync-state";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import type { ExploreData, NewCard } from "@/hooks/use-explore";
import { useIsDesktop } from "@/components/tx-stepper";
import {
  COLORS,
  CONDITIONS,
  ENDS_BANDS,
  EXPLORE_TABS,
  SORTS,
  VS_BANDS,
  activeFilterCount,
  chipValue,
  clearFilters,
  elapsed,
  exploreResults,
  filterOptions,
  languageName,
  shortAgo,
  tabCount,
  toggle,
  type AuctionItem,
  type ExploreFilters,
  type ExploreTab,
} from "@/lib/explore";
import { money } from "@/lib/format";
import { Countdown } from "@/components/countdown";
import { cn } from "@/lib/utils";

export type ExploreViewProps = ExploreData & {
  filters: ExploreFilters;
  onFilters: (f: ExploreFilters) => void;
  /** Unix seconds, for ages. */
  now: number;
  /** Open the mobile filters sheet on mount (previews). */
  defaultSheetOpen?: boolean;
};

// ---------------------------------------------------------------------------------------------------------------------
// Item display

/** "$1,712.00", "$0.22", or "n/a" when there's no price yet. */
const price = (x: bigint | null): string => (x == null ? "n/a" : money(x));

function timeLeft(it: AuctionItem): React.ReactNode {
  if (it.status === "settled") return "settled";
  if (it.status === "awaiting") return "ended";
  return <Countdown endBlock={it.endBlock} />;
}

/** The pill (lib/card-status): Live, Ended · awaiting settle, then how the settled auction ended. */
const statusOf = (it: AuctionItem) => cardStatusOf(it.status === "live" ? "live" : it.status === "awaiting" ? "awaiting" : it.graduated === false ? "reserve-not-met" : "sold");

/** A transparent pixel while the art loads (the card keeps its shape). */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const setLine = (it: AuctionItem) => [it.set, it.condition].filter(Boolean).join(" · ");

function Thumb({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  return src ? <CardArt src={src} alt={alt} className={cn("shrink-0 rounded-[4px] shadow-none", className)} /> : <div className={cn("aspect-[63/88] shrink-0 rounded-[4px] bg-surface-2", className)} />;
}

function Premium({ premium, className }: { premium: number | null; className?: string }) {
  if (premium == null) return null;
  const pct = premium * 100;
  return <span className={cn("font-mono text-[12px]", pct >= 0 ? "text-s1-fg" : "text-shu", className)}>{pct >= 0 ? "+" : ""}{pct.toFixed(1)}%</span>;
}

function ItemCard({ it, block }: { it: AuctionItem; block: bigint }) {
  const s = statusOf(it);
  const pct = Math.round(elapsed(it, block) * 100);
  return (
    <AuctionCard
      href={`/app/cards/${it.cardId}`}
      image={it.image ?? BLANK}
      name={it.name}
      set={setLine(it)}
      clearingPrice={price(it.poolPrice ?? it.clearing)}
      priceLabel={it.poolPrice != null ? "Pool / shard" : undefined}
      premium={it.premium != null ? it.premium * 100 : undefined}
      timeLeft={timeLeft(it)}
      progress={elapsed(it, block)}
      status={s.tone}
      statusLabel={s.label}
      footnote={`${it.forSale} of ${it.totalShards} shards for sale · ${it.status === "live" ? `${pct}% of time elapsed` : it.status === "awaiting" ? "awaiting settle" : it.graduated === false ? "reserve not met" : "settled"}`}
      aria-label={`${it.name}, ${s.label}`}
    />
  );
}

/** Z6BlV0's compact row (and the desktop list view). */
function ItemRow({ it }: { it: AuctionItem }) {
  const live = it.status === "live";
  return (
    <li>
      <Link href={`/app/cards/${it.cardId}`} className="flex items-stretch gap-4 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-text-2/40">
        <Thumb src={it.image} alt={it.name} className="w-[60px] self-center" />
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          <span className="truncate text-[15px] font-semibold text-text">{it.name}</span>
          <span className="truncate text-[12px] text-text-2">{[it.set, `${it.forSale} of ${it.totalShards}`].filter(Boolean).join(" · ")}</span>
          <span className="font-mono text-[20px] leading-tight text-text">{price(it.poolPrice ?? it.clearing)}{it.poolPrice != null && <span className="ml-1.5 font-sans text-[11px] text-muted-foreground">pool</span>}</span>
          <Premium premium={it.premium} />
        </div>
        <div className="flex shrink-0 flex-col items-end justify-end">
          <span className={cn("inline-flex items-center gap-1 rounded-sm bg-surface-2 px-2 py-1 font-mono text-[12px]", live ? "text-shu" : "text-text-2")}>
            {live && <TimerIcon aria-hidden className="size-3" />}
            {timeLeft(it)}
          </span>
        </div>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Controls

function TabSwitch({ tab, counts, onTab, className }: { tab: ExploreTab; counts: Record<ExploreTab, number>; onTab: (t: ExploreTab) => void; className?: string }) {
  return (
    <div role="tablist" aria-label="Auction status" className={cn("flex shrink-0 gap-1 rounded-lg border border-border bg-surface p-1", className)}>
      {EXPLORE_TABS.map((t) => {
        const on = t.value === tab;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onTab(t.value)}
            className={cn("h-[38px] rounded-sm px-4 text-[14px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50", on ? "bg-surface-2 font-semibold text-text" : "text-muted-foreground hover:text-text-2")}
          >
            {t.label}{on && t.value === "live" ? ` · ${counts.live}` : ""}
          </button>
        );
      })}
    </div>
  );
}

function SortMenu({ f, set }: { f: ExploreFilters; set: (p: Partial<ExploreFilters>) => void }) {
  const current = SORTS.find((s) => s.value === f.sort)!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="inline-flex h-12 shrink-0 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-[14px] text-text outline-none hover:bg-surface-2 focus-visible:ring-3 focus-visible:ring-ring/50">
          <ArrowUpDownIcon aria-hidden className="size-4 text-text-2" />{current.label}<ChevronDownIcon aria-hidden className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuRadioGroup value={f.sort} onValueChange={(v) => set({ sort: v as ExploreFilters["sort"] })}>
          {SORTS.map((s) => <DropdownMenuRadioItem key={s.value} value={s.value}>{s.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A filter chip with a checkbox menu. Selecting keeps the menu open. */
function ChipMenu<T extends string>({ label, values, options, onChange, format }: {
  label: string;
  values: readonly T[];
  options: readonly { value: T; label: string }[];
  onChange: (v: T[]) => void;
  format?: (v: T) => string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FilterChip label={label} value={chipValue(values, format as (v: string) => string)} active={values.length > 0} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-52 overflow-y-auto">
        {options.length === 0 && <DropdownMenuItem disabled>Nothing to filter yet</DropdownMenuItem>}
        {options.map((o) => (
          <DropdownMenuCheckboxItem key={o.value} checked={values.includes(o.value)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => onChange(toggle(values, o.value))}>
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
        {values.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange([])}>Clear</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PriceRange({ f, bounds, onChange, className }: { f: ExploreFilters; bounds: { min: number; max: number }; onChange: (p: { pmin: number | null; pmax: number | null }) => void; className?: string }) {
  const lo = f.pmin ?? bounds.min;
  const hi = f.pmax ?? bounds.max;
  const max = Math.max(bounds.max, hi, bounds.min + 1);
  const min = Math.min(bounds.min, lo);
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between text-[13px]">
        <span className="text-text-2">Price per shard</span>
        <span className="font-mono text-text">${lo.toLocaleString("en-US")} – ${hi.toLocaleString("en-US")}</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={Math.max(1, Math.round((max - min) / 100))}
        value={[lo, hi]}
        onValueChange={([a, b]) => onChange({ pmin: a! <= bounds.min ? null : a!, pmax: b! >= bounds.max ? null : b! })}
        aria-label="Price per shard"
        className="py-2 [&_[data-slot=slider-range]]:bg-shu [&_[data-slot=slider-thumb]]:size-6 [&_[data-slot=slider-thumb]]:border-[3px] [&_[data-slot=slider-thumb]]:border-shu [&_[data-slot=slider-thumb]]:bg-text [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-track]]:bg-surface-2"
      />
    </div>
  );
}

function PriceChip({ f, bounds, set }: { f: ExploreFilters; bounds: { min: number; max: number }; set: (p: Partial<ExploreFilters>) => void }) {
  const on = f.pmin != null || f.pmax != null;
  const value = on ? `$${(f.pmin ?? bounds.min).toLocaleString("en-US")}–$${(f.pmax ?? bounds.max).toLocaleString("en-US")}` : "Any";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FilterChip label="Price / shard" value={value} active={on} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-4">
        <PriceRange f={f} bounds={bounds} onChange={set} />
        {on && <button type="button" onClick={() => set({ pmin: null, pmax: null })} className="mt-3 text-[12px] text-text-2 hover:text-text">Clear</button>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Options = ReturnType<typeof filterOptions>;
const opts = (values: readonly string[], label: (v: string) => string = (v) => v) => values.map((v) => ({ value: v, label: label(v) }));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function FilterBar({ f, o, set }: { f: ExploreFilters; o: Options; set: (p: Partial<ExploreFilters>) => void }) {
  const bounds = { min: o.priceMin, max: o.priceMax };
  // A value set by a link stays listed even when no item in view has it.
  const withSelected = (values: readonly string[], selected: readonly string[]) => [...new Set([...values, ...selected])];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ChipMenu label="Set" values={f.set} options={opts(withSelected(o.sets, f.set))} onChange={(set_) => set({ set: set_ })} />
      <ChipMenu label="Condition" values={f.cond} options={opts(CONDITIONS)} onChange={(cond) => set({ cond })} />
      <ChipMenu label="Language" values={f.lang} options={opts(withSelected(o.languages, f.lang), languageName)} onChange={(lang) => set({ lang })} format={(v) => v.toUpperCase()} />
      <ChipMenu label="Rarity" values={f.rarity} options={opts(withSelected(o.rarities, f.rarity), cap)} onChange={(rarity) => set({ rarity })} format={cap} />
      <ChipMenu label="Color" values={f.color} options={COLORS} onChange={(color) => set({ color })} />
      <PriceChip f={f} bounds={bounds} set={set} />
      <ChipMenu label="Vs market" values={f.vs} options={VS_BANDS} onChange={(vs) => set({ vs })} format={(v) => VS_BANDS.find((b) => b.value === v)!.label} />
      <ChipMenu label="Ends" values={f.ends} options={ENDS_BANDS} onChange={(ends) => set({ ends })} format={(v) => ENDS_BANDS.find((b) => b.value === v)!.label} />
      {activeFilterCount(f) > 0 && (
        <button type="button" onClick={() => set(clearFilters({ ...f, q: "" }))} className="ml-auto text-[13px] text-text-2 hover:text-text">Clear all</button>
      )}
    </div>
  );
}

/** A chip in the mobile sheet and quick row: pill, shu-outlined when on. */
function SheetChip({ on, onClick, quick = false, children }: { on: boolean; onClick: () => void; /** Z6BlV0's quick row: an "on" chip is filled white. */ quick?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("h-9 shrink-0 rounded-full border px-3.5 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50", on ? (quick ? "border-text bg-text font-semibold text-bg" : "border-shu bg-shu-soft font-semibold text-text") : "border-border bg-surface text-text-2 hover:bg-surface-2")}
    >
      {children}
    </button>
  );
}

function SheetGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-[13px] text-text-2">{label}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/** aUlMV: the mobile filters sheet. Edits a draft; "Show N auctions" applies it. */
function FiltersSheet({ open, onOpenChange, f, items, block, o, onApply }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  f: ExploreFilters;
  items: readonly AuctionItem[];
  block: bigint;
  o: Options;
  onApply: (f: ExploreFilters) => void;
}) {
  const [draft, setDraft] = useState(f);
  const [prevOpen, setPrevOpen] = useState(open);
  // Each opening starts from the applied filters.
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setDraft(f);
  }
  const set = (p: Partial<ExploreFilters>) => setDraft((d) => ({ ...d, ...p }));
  const n = exploreResults(items, draft, block).length;
  const sets = [...new Set([...o.sets.slice(0, 6), ...draft.set])];
  const languages = [...new Set([...o.languages, ...draft.lang])];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false} onOpenAutoFocus={(e) => e.preventDefault()} className="mx-auto flex max-h-[92dvh] w-full max-w-lg flex-col gap-5 overflow-y-auto rounded-t-3xl border-border bg-surface px-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))]">
        <span aria-hidden className="mx-auto h-1 w-10 rounded-full bg-border" />
        <div className="flex items-center justify-between">
          <SheetTitle className="font-display text-[24px] font-semibold text-text">Filters</SheetTitle>
          <button type="button" onClick={() => setDraft(clearFilters({ ...draft, tab: "live" }))} className="text-[14px] text-text-2 hover:text-text">Reset</button>
        </div>
        <SheetDescription className="sr-only">Narrow the auctions by status, set, condition, language, market and price.</SheetDescription>
        <SheetGroup label="Status">
          {EXPLORE_TABS.map((t) => <SheetChip key={t.value} on={draft.tab === t.value} onClick={() => set({ tab: t.value })}>{t.label}</SheetChip>)}
        </SheetGroup>
        <SheetGroup label="Set">
          {sets.map((s) => <SheetChip key={s} on={draft.set.includes(s)} onClick={() => set({ set: toggle(draft.set, s) })}>{s}</SheetChip>)}
          <SheetChip on={draft.set.length === 0} onClick={() => set({ set: [] })}>All sets</SheetChip>
        </SheetGroup>
        <SheetGroup label="Condition">
          {CONDITIONS.map((c) => <SheetChip key={c} on={draft.cond.includes(c)} onClick={() => set({ cond: toggle(draft.cond, c) })}>{c}</SheetChip>)}
        </SheetGroup>
        {languages.length > 0 && (
          <SheetGroup label="Language">
            {languages.map((l) => <SheetChip key={l} on={draft.lang.includes(l)} onClick={() => set({ lang: toggle(draft.lang, l) })}>{l.toUpperCase()}</SheetChip>)}
          </SheetGroup>
        )}
        <SheetGroup label="Vs market">
          {VS_BANDS.map((b) => <SheetChip key={b.value} on={draft.vs.includes(b.value)} onClick={() => set({ vs: toggle(draft.vs, b.value) })}>{b.label.replace(" market", "")}</SheetChip>)}
        </SheetGroup>
        {o.priceMax > o.priceMin && <PriceRange f={draft} bounds={{ min: o.priceMin, max: o.priceMax }} onChange={set} />}
        <Button variant="primary" size="md" className="mt-4 h-[52px] w-full rounded-xl text-[15px]" onClick={() => { onApply(draft); onOpenChange(false); }}>
          Show {n} auction{n === 1 ? "" : "s"}
        </Button>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// States

function EmptyCard({ icon, title, children, actions, className }: { icon: React.ReactNode; title: string; children: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-3 px-6 py-16 text-center", className)}>
      <span className="flex size-16 items-center justify-center rounded-2xl bg-surface text-text-2 [&_svg]:size-6">{icon}</span>
      <h2 className="mt-3 font-display text-[24px] font-semibold text-text">{title}</h2>
      <p className="max-w-[340px] text-[14px] text-text-2">{children}</p>
      {actions && <div className="mt-2 flex flex-wrap justify-center gap-2.5">{actions}</div>}
    </div>
  );
}

const NO_MATCH_TITLE: Record<ExploreTab, string> = { live: "No live auctions match", soon: "No auctions ending soon match", upcoming: "Nothing upcoming", ended: "No ended auctions match" };

function LoadingGrid() {
  return (
    <div className="flex flex-col gap-4">
      <IndexerLoading title="Loading auctions" className="max-w-md" />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[400px] rounded-2xl bg-surface" />)}
      </div>
    </div>
  );
}

function NewInVault({ cards, now }: { cards: readonly NewCard[]; now: number }) {
  if (cards.length === 0) return null;
  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-[24px] font-semibold text-text md:text-[28px]">New in the vault</h2>
        <p className="text-[13px] text-text-2">Freshly scanned by the vendor. Owners can shard them any time.</p>
      </header>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((c) => (
          <li key={c.id.toString()}>
            <Link href={`/app/cards/${c.id}`} className="flex items-center gap-3.5 rounded-2xl border border-border bg-surface p-3.5 transition-colors hover:border-text-2/40">
              <Thumb src={c.image} alt={c.name} className="w-9" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[14px] font-semibold text-text">{c.name}</span>
                <AddressName address={c.owner} avatar={false} copyable={false} tone="kin" maxWidthClassName="max-w-[11rem]" className="[&>span]:text-[12px]" />
                <span className="text-[12px] text-muted-foreground">{shortAgo(c.mintedAt, now)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Page

/** Explore (TQ4jp desktop, Z6BlV0 mobile, aUlMV filters, NWOiJ no results). Filters live in the URL (the page's job). */
export function ExploreView({ items, newCards, block, isLoading, filters: f, onFilters, now, defaultSheetOpen = false }: ExploreViewProps) {
  const [sheet, setSheet] = useState(false);
  const desktop = useIsDesktop();
  // Previews ask for the sheet open; opened after mount so the portal renders on the client.
  useEffect(() => {
    if (!defaultSheetOpen) return;
    const id = requestAnimationFrame(() => setSheet(true));
    return () => cancelAnimationFrame(id);
  }, [defaultSheetOpen]);
  const search = useRef<HTMLInputElement>(null);
  const set = (p: Partial<ExploreFilters>) => onFilters({ ...f, ...p });
  const head = block ?? 0n;

  // "/" focuses the search, as its kbd hint says.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "/" || el?.closest("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counts = Object.fromEntries(EXPLORE_TABS.map((t) => [t.value, tabCount(items, t.value, head)])) as Record<ExploreTab, number>;
  const results = exploreResults(items, f, head);
  const o = filterOptions(items.filter((it) => it.status === "live" || f.tab === "ended"));
  const nFilters = activeFilterCount(f);
  const narrowed = nFilters > 0 || f.q.trim() !== "";
  const quickSet = o.sets[0];
  const quickCond = o.conditions[0];

  let body: React.ReactNode;
  if (isLoading) body = <LoadingGrid />;
  else if (f.tab === "upcoming") {
    body = <EmptyCard icon={<CompassIcon />} title="Nothing upcoming">Auctions open the moment a card is sharded, so there is never a queue. See what&apos;s live now.</EmptyCard>;
  } else if (items.length === 0) {
    body = <EmptyCard icon={<CompassIcon />} title="No auctions yet">Auctions open the moment an owner shards a card in the vault. Check back soon, or look at what&apos;s new below.</EmptyCard>;
  } else if (results.length === 0) {
    body = (
      <EmptyCard
        icon={<SearchXIcon />}
        title={narrowed ? NO_MATCH_TITLE[f.tab] : f.tab === "ended" ? "No ended auctions yet" : "No live auctions right now"}
        actions={
          <>
            {narrowed && <Button variant="inverse" size="md" onClick={() => onFilters(clearFilters(f))}>Clear filters</Button>}
            {f.tab !== "ended" && <Button variant="secondary" size="md" onClick={() => set({ tab: "ended" })}>Show ended</Button>}
          </>
        }
      >
        {narrowed
          ? `${f.q.trim() ? `Nothing matching “${f.q.trim()}”` : "Nothing with these filters"} is ${f.tab === "ended" ? "in the ended auctions" : "up right now"}. Try other filters${f.tab !== "ended" ? ", or look at ended auctions" : ""}.`
          : "Every auction has ended. Shard a card to open the next one, or look at the ended auctions."}
      </EmptyCard>
    );
  } else {
    body = (
      <>
        <ul className={cn("flex flex-col gap-3", f.view === "grid" ? "md:hidden" : "md:grid md:grid-cols-2 xl:grid-cols-3")}>
          {results.map((it) => <ItemRow key={it.auction} it={it} />)}
        </ul>
        {f.view === "grid" && (
          <div className="grid grid-cols-2 gap-5 max-md:hidden lg:grid-cols-3 xl:grid-cols-4">
            {results.map((it) => <ItemCard key={it.auction} it={it} block={head} />)}
          </div>
        )}
      </>
    );
  }

  return (
    <section className="flex flex-col gap-5 md:gap-6">
      <MobilePageTitle title="Explore" className="-mt-2" />
      <header className="flex flex-col gap-1 max-md:hidden">
        <h1 className="font-display text-[32px] font-semibold text-text">Live auctions</h1>
        <p className="text-[14px] text-text-2">Uniswap continuous clearing auctions. Set a budget and a max price, everyone pays the same.</p>
      </header>

      <div className="flex flex-col gap-3 max-md:-mt-1 md:gap-4">
        <div className="flex items-center gap-3">
          <SearchInput
            ref={search}
            value={f.q}
            onChange={(e) => set({ q: e.target.value })}
            kbd="/"
            boxClassName="h-12 flex-1 rounded-xl py-0 max-md:h-[52px] max-md:rounded-2xl [&_kbd]:max-md:hidden"
            placeholder={desktop ? "Search cards, sets or ENS names" : "Search cards or sets"}
            aria-label="Search auctions"
          />
          <button
            type="button"
            onClick={() => setSheet(true)}
            aria-label={`Filters${nFilters ? `, ${nFilters} applied` : ""}`}
            className="relative flex h-[52px] shrink-0 items-center gap-2 rounded-2xl border border-border bg-surface px-4 text-text md:hidden"
          >
            <SlidersHorizontalIcon aria-hidden className="size-5" />
            {nFilters > 0 && <span className="flex size-5 items-center justify-center rounded-full bg-shu font-mono text-[11px] font-semibold text-white">{nFilters}</span>}
          </button>
          <TabSwitch tab={f.tab} counts={counts} onTab={(tab) => set({ tab })} className="max-lg:hidden" />
          <div className="max-md:hidden"><SortMenu f={f} set={set} /></div>
        </div>
        <TabSwitch tab={f.tab} counts={counts} onTab={(tab) => set({ tab })} className="w-fit max-md:hidden lg:hidden" />

        {/* Mobile quick chips: Live, New, the most common set and condition. */}
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 md:hidden">
          <SheetChip quick on={f.tab === "live"} onClick={() => set({ tab: f.tab === "live" ? "ended" : "live" })}>Live</SheetChip>
          <SheetChip quick on={f.sort === "newest"} onClick={() => set({ sort: f.sort === "newest" ? "ending" : "newest" })}>New</SheetChip>
          {quickSet && <SheetChip quick on={f.set.includes(quickSet)} onClick={() => set({ set: toggle(f.set, quickSet) })}>{quickSet}</SheetChip>}
          {quickCond && <SheetChip quick on={f.cond.includes(quickCond)} onClick={() => set({ cond: toggle(f.cond, quickCond) })}>{quickCond}</SheetChip>}
        </div>

        <div className="max-md:hidden"><FilterBar f={f} o={o} set={set} /></div>
        {!isLoading && f.tab !== "upcoming" && items.length > 0 && (
          <div className="flex items-center justify-between max-md:hidden">
            <span className="text-[13px] text-text-2">
              {results.length} auction{results.length === 1 ? "" : "s"}{nFilters > 0 ? ` · ${nFilters} filter${nFilters === 1 ? "" : "s"} applied` : ""}
            </span>
            <div role="group" aria-label="Layout" className="flex gap-1">
              {(["grid", "list"] as const).map((v) => {
                const Icon = v === "grid" ? LayoutGridIcon : ListIcon;
                return (
                  <button key={v} type="button" aria-pressed={f.view === v} aria-label={v === "grid" ? "Grid" : "List"} onClick={() => set({ view: v })} className={cn("flex size-8 items-center justify-center rounded-md", f.view === v ? "bg-surface-2 text-text" : "text-muted-foreground hover:text-text")}>
                    <Icon aria-hidden className="size-4" />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {body}

      <div className="mt-6"><NewInVault cards={newCards} now={now} /></div>

      <FiltersSheet open={sheet} onOpenChange={setSheet} f={f} items={items} block={head} o={o} onApply={onFilters} />
    </section>
  );
}

