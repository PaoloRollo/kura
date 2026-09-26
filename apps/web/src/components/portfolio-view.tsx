"use client";

import type * as React from "react";
import { useCallback, useState } from "react";
import Link from "next/link";
import { asc, eq } from "@ponder/client";
import { usePonderQuery } from "@ponder/react";
import {
  AtSignIcon, BadgeCheckIcon, BoxIcon, CircleDollarSignIcon, CompassIcon, GavelIcon, LayersIcon, PackageCheckIcon, PackageIcon, TrendingDownIcon, TrendingUpIcon,
} from "lucide-react";
import { AddressName } from "@/components/address-name";
import { Button, CardArt, Pill } from "@/components/kura";
import { MyBids } from "@/components/my-bids";
import { AvatarLink, MobilePageTitle } from "@/components/page-title";
import { PayoutPanel } from "@/components/payout-panel";
import { IndexerLoading } from "@/components/sync-state";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { BidRow, CheckpointRow } from "@/hooks/use-card";
import type { PortfolioData, ReleasedItem } from "@/hooks/use-portfolio";
import { money, shardsFixed, shortAddress, usdc } from "@/lib/format";
import { schema, t } from "@/lib/ponder";
import { shortLeft, type BidItem, type Holding, type WholeCard } from "@/lib/portfolio";
import { cn } from "@/lib/utils";

type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];
export type PortfolioTab = "shards" | "whole" | "bids";
export const PORTFOLIO_TABS: readonly PortfolioTab[] = ["shards", "whole", "bids"];

/** "$1,712" for whole dollars and big values, else "$17.50". */
const price = (x: bigint | null) => (x == null ? "n/a" : x >= 1_000_000_000n || x % 1_000_000n === 0n ? money(x, 0) : money(x));
/** A gain: whole dollars from $100 up ("+$1,976", "-$72"), cents below ("+$18.40"). */
const signed = (x: bigint) => {
  const abs = x < 0n ? -x : x;
  return `${x < 0n ? "-" : "+"}${abs >= 100_000_000n ? money(abs, 0) : money(abs)}`;
};
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function Thumb({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  return src ? <CardArt src={src} alt={alt} className={cn("shrink-0 rounded-[3px] shadow-none", className)} /> : <div className={cn("aspect-[63/88] shrink-0 rounded-[3px] bg-surface-2", className)} />;
}

function Chip({ icon: Icon, children, href, tone }: { icon: typeof AtSignIcon; children: React.ReactNode; href?: string; tone?: "good" | "kin" }) {
  const cls = "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-border bg-surface px-3.5 text-[13px] text-text";
  const body = (
    <>
      <Icon aria-hidden className={cn("size-4", tone === "good" ? "text-good-fg" : tone === "kin" ? "text-kin" : "text-text-2")} />
      {children}
    </>
  );
  return href ? <Link href={href} className={cn(cls, "hover:bg-surface-2")}>{body}</Link> : <span className={cls}>{body}</span>;
}

/** USDC, World ID and handle chips (a short address linking to onboarding without a handle). */
function WalletChips({ d }: { d: PortfolioData }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:justify-end md:px-0">
      <Chip icon={CircleDollarSignIcon}><span className="font-mono">{d.usdc != null ? usdc(d.usdc) : "…"} USDC</span></Chip>
      {d.verified
        ? <Chip icon={BadgeCheckIcon} tone="good"><span className="md:hidden">World ID</span><span className="max-md:hidden">World ID verified</span></Chip>
        : <Chip icon={BadgeCheckIcon}>Not verified</Chip>}
      {d.handle
        ? <Chip icon={AtSignIcon} tone="kin"><AddressName address={d.me} avatar={false} copyable={false} maxWidthClassName="max-w-[12rem]" /></Chip>
        : <Chip icon={AtSignIcon} tone="kin" href="/app/onboarding"><span className="font-mono">{shortAddress(d.me)}</span><span className="text-text-2">· claim a handle</span></Chip>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Shards

function HoldingPill({ h }: { h: Holding }) {
  if (h.liveLeft != null) return <Pill tone="live" dot={false} className="px-2 py-1 text-[11px]">Live · {shortLeft(h.liveLeft)}</Pill>;
  if (h.redeemable) return <Pill tone="redeemable" dot={false} className="px-2 py-1 text-[11px]">Redeemable</Pill>;
  return null;
}

function ShareBar({ h, className }: { h: Holding; className?: string }) {
  return (
    <div className={cn("h-1.5 w-full rounded-full bg-surface-2", className)} aria-hidden>
      <div className={cn("h-full rounded-full", h.redeemable ? "bg-kin" : "bg-s1")} style={{ width: `${Math.max(2, h.share * 100)}%` }} />
    </div>
  );
}

const Gain = ({ gain, className }: { gain: bigint | null; className?: string }) =>
  gain == null ? null : <span className={cn("font-mono text-[12px]", gain >= 0n ? "text-good-fg" : "text-shu", className)}>{signed(gain)}</span>;

function ShardsTable({ rows }: { rows: readonly Holding[] }) {
  return (
    <>
      {/* 1440: the table. */}
      <div className="overflow-x-auto max-md:hidden">
        <table className="w-full min-w-[720px] text-left">
          <thead>
            <tr className="border-b border-border text-[12px] text-muted-foreground [&>th]:px-5 [&>th]:py-3 [&>th]:font-normal">
              <th>Card</th><th>Shards</th><th>Share</th><th>Avg cost</th><th>Price now</th><th className="text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.shardToken} className="border-b border-border last:border-0 hover:bg-surface-2/40 [&>td]:px-5 [&>td]:py-4">
                <td>
                  <Link href={`/app/portfolio/${h.cardId}`} className="flex items-center gap-4">
                    <Thumb src={h.image} alt={h.name} className="w-8" />
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="truncate text-[14px] font-semibold text-text">{h.name}</span>
                      <HoldingPill h={h} />
                    </span>
                  </Link>
                </td>
                <td className="font-mono text-[14px] whitespace-nowrap text-text">{shardsFixed(h.balance)} / {h.totalShards}</td>
                <td>
                  <div className="flex items-center gap-3">
                    <ShareBar h={h} className="w-24" />
                    <span className="font-mono text-[12px] text-text-2">{(h.share * 100).toFixed(1)}%</span>
                  </div>
                </td>
                <td className="font-mono text-[14px] text-text" title={h.costKind === "floor" ? "Your floor price" : undefined}>{price(h.cost)}</td>
                <td className="font-mono text-[14px] text-text">{price(h.price)}</td>
                <td className="text-right">
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="font-mono text-[15px] text-text">{price(h.value)}</span>
                    <Gain gain={h.gain} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* 390: cards (YH4Ft). */}
      <ul className="flex flex-col gap-3 md:hidden">
        {rows.map((h) => (
          <li key={h.shardToken}>
            <Link href={`/app/portfolio/${h.cardId}`} className={cn("flex items-center gap-4 rounded-2xl border bg-surface p-4", h.redeemable ? "border-kin/40" : "border-border")}>
              <Thumb src={h.image} alt={h.name} className="w-12" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[15px] font-semibold text-text">{h.name}</span>
                  <HoldingPill h={h} />
                </div>
                <span className="font-mono text-[12px] text-text-2">{shardsFixed(h.balance)} / {h.totalShards} shards · {Math.round(h.share * 100)}%</span>
                <ShareBar h={h} />
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="font-mono text-[15px] text-text">{price(h.value)}</span>
                <Gain gain={h.gain} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Whole cards

/** Pick up (BJyHN): the Passport handover at the counter, explained. The card page runs it; no transaction here. */
function PickupSheet({ card, onOpenChange }: { card: WholeCard | null; onOpenChange: (o: boolean) => void }) {
  return (
    <Sheet open={!!card} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto max-w-lg rounded-t-3xl border-border bg-surface p-6">
        <span className="flex size-12 items-center justify-center rounded-xl bg-kin-soft text-kin"><PackageIcon aria-hidden className="size-6" /></span>
        <SheetTitle className="font-display text-[24px] font-semibold text-text">Pick up {card?.name ?? "your card"}</SheetTitle>
        <SheetDescription className="text-[14px] text-text-2">
          Come to the Kura counter in Tokyo with your Passport. On the card page, verify with World ID and show the screen to the vendor: they check your Passport and hand the card over. Its ENS name is revoked on release.
        </SheetDescription>
        {card && (
          <Button asChild variant="primary" size="md" className="h-12 w-full rounded-xl">
            <Link href={`/app/cards/${card.cardId}`}><PackageIcon aria-hidden />Collect at the counter</Link>
          </Button>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** mnpO6 "Released · Handed over at the counter", for a card I took home. */
export function ReleasedCardState({ r }: { r: ReleasedItem }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
      <span className="w-fit rounded-md bg-surface-2 px-2 py-1 text-[10px] font-semibold tracking-[1px] text-text-2 uppercase">Released</span>
      <span className="flex size-11 items-center justify-center rounded-lg bg-surface-2 text-good-fg"><PackageCheckIcon aria-hidden className="size-5" /></span>
      <div className="flex flex-col gap-1.5">
        <h4 className="text-[16px] font-semibold text-text">Handed over at the counter</h4>
        <p className="text-[13px] text-text-2">
          {r.name} left the vault{r.releasedAt != null ? ` on ${day(r.releasedAt)}` : ""}. Its ENS name was revoked. The token remains as a record.
        </p>
        {r.ensName && <span className="truncate font-mono text-[12px] text-muted-foreground">{r.ensName}</span>}
      </div>
    </div>
  );
}

function WholeList({ whole, released }: { whole: readonly WholeCard[]; released: readonly ReleasedItem[] }) {
  const [pickup, setPickup] = useState<WholeCard | null>(null);
  return (
    <div className="flex flex-col gap-3 md:p-5">
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {whole.map((w) => (
          <li key={w.cardId.toString()} className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 md:bg-bg/40">
            <Link href={`/app/cards/${w.cardId}`} className="flex items-center gap-4">
              <Thumb src={w.image} alt={w.name} className="w-12" />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-[16px] font-semibold text-text">{w.name}</span>
                <span className="text-[12px] text-text-2">{w.condition}</span>
              </span>
              <span className="font-mono text-[15px] text-text">{w.value != null ? price(w.value) : "no price"}</span>
            </Link>
            <div className="grid grid-cols-2 gap-2.5">
              <Button asChild variant="primary" size="md" className="h-11 rounded-xl"><Link href={`/app/cards/${w.cardId}/shard`}><LayersIcon aria-hidden />Shard</Link></Button>
              <Button variant="secondary" size="md" className="h-11 rounded-xl" onClick={() => setPickup(w)}><BoxIcon aria-hidden />Pick up</Button>
            </div>
          </li>
        ))}
      </ul>
      {whole.length > 0 && <p className="text-[13px] text-text-2">Whole cards are 100% yours. Shard one to sell part of it, or pick it up at the vault.</p>}
      {released.length > 0 && (
        <div className="grid grid-cols-1 gap-3 pt-2 lg:grid-cols-2">
          {released.map((r) => <ReleasedCardState key={r.cardId.toString()} r={r} />)}
        </div>
      )}
      <PickupSheet card={pickup} onOpenChange={(o) => !o && setPickup(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Bids

const LINE_TONE: Record<BidItem["line"]["tone"], string> = { good: "text-good-fg", shu: "text-shu", muted: "text-text-2", kin: "text-kin" };

/** Claim (K7qgeI): the ended bid's exit and claim, through Task 6's My bids with the auction's checkpoints. */
function ClaimSheet({ item, onOpenChange }: { item: BidItem | null; onOpenChange: (o: boolean) => void }) {
  const auction = (item?.bid.auction ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
  const cps = usePonderQuery({
    queryFn: useCallback(
      (db: Db) => db.select().from(t(schema.checkpoints)).where(eq(t(schema.checkpoints.auction), auction)).orderBy(asc(t(schema.checkpoints.blockNumber))) as Promise<CheckpointRow[]>,
      [auction],
    ),
  });
  const s = item?.sharding;
  return (
    <Sheet open={!!item} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border-border bg-surface p-6">
        <SheetTitle className="font-display text-[22px] font-semibold text-text">{item?.name ?? "Your bid"}</SheetTitle>
        <SheetDescription className="text-[13px] text-text-2">Exit the bid to lock in what filled and take back what wasn&apos;t spent, then claim the shards.</SheetDescription>
        {item && s && (
          <MyBids
            bids={[item.bid as unknown as BidRow]}
            auction={auction}
            ended
            settled={s.settled}
            graduated={s.graduated}
            clearingQ96={s.clearingPriceQ96 ?? 0n}
            checkpoints={cps.data ?? []}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function BidRowItem({ b, onClaim }: { b: BidItem; onClaim: () => void }) {
  return (
    <li className="flex items-center gap-4 rounded-2xl border border-border bg-surface p-4 md:bg-bg/40">
      <Link href={`/app/cards/${b.cardId}`} className="flex min-w-0 flex-1 items-center gap-4">
        <Thumb src={b.image} alt={b.name} className="w-10" />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-[15px] font-semibold text-text">{b.name}</span>
          <span className="font-mono text-[12px] text-text-2">{price(b.bid.amountUsdc)} up to {money(b.maxUsdcPerShard, b.maxUsdcPerShard < 100_000_000n ? 2 : 0)}</span>
          <span className={cn("text-[12px]", LINE_TONE[b.line.tone])}>{b.line.text}</span>
        </span>
      </Link>
      {b.action === "raise" && <Button asChild variant="secondary" size="compact" className="shrink-0"><Link href={`/app/cards/${b.cardId}`}>Raise</Link></Button>}
      {b.action === "claim" && <Button variant="primary" size="compact" className="shrink-0" onClick={onClaim}>Claim</Button>}
    </li>
  );
}

function BidsList({ bids }: { bids: PortfolioData["bids"] }) {
  const [claim, setClaim] = useState<BidItem | null>(null);
  const group = (label: string, items: readonly BidItem[]) =>
    items.length > 0 && (
      <div className="flex flex-col gap-2.5">
        <span className="text-[11px] font-semibold tracking-[1px] text-muted-foreground uppercase">{label}</span>
        <ul className="flex flex-col gap-2.5">{items.map((b) => <BidRowItem key={b.bid.id} b={b} onClaim={() => setClaim(b)} />)}</ul>
      </div>
    );
  return (
    <div className="flex flex-col gap-5 md:p-5">
      {group("Live", bids.live)}
      {group("Ended", bids.ended)}
      <ClaimSheet item={claim} onOpenChange={(o) => !o && setClaim(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Page

function Empty({ icon, label, title, body, cta, className }: { icon: React.ReactNode; label?: string; title: string; body: string; cta?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-start gap-3 rounded-2xl border border-border bg-surface p-5 md:m-5 md:max-w-sm", className)}>
      {label && <span className="rounded-md bg-surface-2 px-2 py-1 text-[10px] font-semibold tracking-[1px] text-text-2 uppercase">{label}</span>}
      <span className="flex size-11 items-center justify-center rounded-lg bg-surface-2 text-text-2 [&_svg]:size-5">{icon}</span>
      <div className="flex flex-col gap-1.5">
        <h4 className="text-[16px] font-semibold text-text">{title}</h4>
        <p className="text-[13px] text-text-2">{body}</p>
      </div>
      {cta}
    </div>
  );
}

const exploreCta = <Button asChild variant="secondary" size="compact"><Link href="/app">Explore auctions</Link></Button>;

function TabStrip({ tab, onTab, counts }: { tab: PortfolioTab; onTab: (t: PortfolioTab) => void; counts: Record<PortfolioTab, number> }) {
  const label: Record<PortfolioTab, string> = { shards: "Shards", whole: "Whole cards", bids: "Bids" };
  return (
    <div role="tablist" aria-label="Portfolio" className="flex gap-6 border-border md:gap-1 md:border-b md:p-3 max-md:border-0">
      {PORTFOLIO_TABS.map((v) => {
        const on = v === tab;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onTab(v)}
            className={cn(
              "shrink-0 text-[15px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              // 390: underlined text tabs; 1440: pill tabs with counts.
              "max-md:-mb-px max-md:border-b-2 max-md:pb-2.5",
              "md:h-9 md:rounded-md md:px-3 md:text-[14px]",
              on ? "font-semibold text-text max-md:border-shu md:bg-surface-2" : "text-text-2 hover:text-text max-md:border-transparent",
            )}
          >
            {label[v]}<span className="max-md:hidden"> · {counts[v]}</span>
          </button>
        );
      })}
    </div>
  );
}

function AllocationCard({ parts }: { parts: PortfolioData["allocation"] }) {
  if (parts.length === 0) return null;
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5">
      <h2 className="text-[16px] font-semibold text-text">Allocation</h2>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {parts.map((p) => <span key={p.name} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${p.share * 100}%`, background: p.color }} />)}
      </div>
      <ul className="flex flex-col gap-3">
        {parts.map((p) => (
          <li key={p.name} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2 text-text"><span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: p.color }} /><span className="truncate">{p.name}</span></span>
            <span className="font-mono text-text-2">{Math.round(p.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export type PortfolioViewProps = { d: PortfolioData; tab: PortfolioTab; onTab: (t: PortfolioTab) => void };

/** Collector · Portfolio (QEEV7 at 1440; YH4Ft, BJyHN, K7qgeI at 390). */
export function PortfolioView({ d, tab, onTab }: PortfolioViewProps) {
  const counts: Record<PortfolioTab, number> = { shards: d.holdings.length, whole: d.whole.length + d.released.length, bids: d.bids.live.length + d.bids.ended.length };
  const empty = !d.isLoading && counts.shards + counts.whole + counts.bids + d.payouts.length === 0;
  const up = d.totals.gain >= 0n;
  const TrendIcon = up ? TrendingUpIcon : TrendingDownIcon;

  let body: React.ReactNode;
  if (tab === "shards") {
    body = d.holdings.length > 0 ? <ShardsTable rows={d.holdings} /> : <Empty icon={<BoxIcon />} label="Empty portfolio" title="No shards yet" body="Browse live auctions to own a piece of a card." cta={exploreCta} />;
  } else if (tab === "whole") {
    body = counts.whole > 0 ? <WholeList whole={d.whole} released={d.released} /> : <Empty icon={<PackageIcon />} title="No whole cards" body="Cards the vendor scans in for you show here, 100% yours until you shard them." />;
  } else {
    body = counts.bids > 0 ? <BidsList bids={d.bids} /> : <Empty icon={<GavelIcon />} title="No bids yet" body="Bid in a live auction: set a budget and a max price, everyone pays the same clearing price." cta={exploreCta} />;
  }

  return (
    <section className="flex flex-col gap-6 md:gap-8">
      <MobilePageTitle title="Portfolio" right={<AvatarLink />} className="-mt-2" />
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-text-2">Portfolio value</span>
          <span className="font-mono text-[44px] leading-none text-text md:text-[64px]">{d.isLoading ? "…" : money(d.totals.value)}</span>
          {!d.isLoading && d.totals.cards > 0 && (
            <span className={cn("inline-flex items-center gap-1.5 text-[13px]", up ? "text-good-fg" : "text-shu")}>
              <TrendIcon aria-hidden className="size-4" />
              <span>
                {signed(d.totals.gain)} unrealized<span className="max-md:hidden"> across</span><span className="md:hidden"> ·</span> {d.totals.cards} card{d.totals.cards === 1 ? "" : "s"}
              </span>
            </span>
          )}
        </div>
        <WalletChips d={d} />
      </header>

      {d.payouts.map((p) => (
        <PayoutPanel
          key={p.sharding.shardToken}
          layout="banner"
          me={d.me}
          cardName={p.name}
          sharding={{ cardId: p.sharding.cardId, shardToken: p.sharding.shardToken, buyoutPerShard: p.sharding.buyoutPerShard!, redeemer: p.sharding.redeemer }}
        />
      ))}

      {d.isLoading ? (
        <IndexerLoading title="Loading your portfolio" className="max-w-md" />
      ) : empty ? (
        <Empty className="md:m-0" icon={<BoxIcon />} label="Empty portfolio" title="No shards yet" body="Browse live auctions to own a piece of a card." cta={<Button asChild variant="secondary" size="compact"><Link href="/app"><CompassIcon aria-hidden />Explore auctions</Link></Button>} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex flex-col gap-4 md:rounded-2xl md:border md:border-border md:bg-surface">
            <TabStrip tab={tab} onTab={onTab} counts={counts} />
            {body}
          </div>
          <div className="max-md:hidden"><AllocationCard parts={d.allocation} /></div>
        </div>
      )}
    </section>
  );
}
