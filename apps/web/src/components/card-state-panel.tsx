"use client";

import type * as React from "react";
import { useState } from "react";
import Link from "next/link";
import { LayersIcon, PackageIcon, PackageCheckIcon } from "lucide-react";
import { q96ToUsdcPerShard } from "@kura/shared";
import { AddressName } from "@/components/address-name";
import { Button } from "@/components/kura";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { CardData, ShardingRow } from "@/hooks/use-card";
import { explorerTx } from "@/lib/chain";
import { countdown, money, shardsFixed, shortHash } from "@/lib/format";
import { dateTime } from "@/lib/card-view";
import { priceSourceLabel, quoteUsdc, vsMarket } from "@/lib/pricing";
import { cn } from "@/lib/utils";

function Stat({ label, value, sub, tone, small }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "shu" | "good" | "kin"; small?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className={cn("text-muted-foreground", small ? "text-[11px]" : "text-[12px] tracking-[0.5px] uppercase")}>{label}</span>
      <span className={cn("truncate font-mono", small ? "text-[15px]" : "text-[26px] leading-tight md:text-[30px]", tone === "shu" ? "text-shu" : tone === "good" ? "text-good-fg" : tone === "kin" ? "text-kin" : "text-text")}>{value}</span>
      {sub && <span className="text-[12px] text-text-2">{sub}</span>}
    </div>
  );
}

const Panel = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <section className={cn("rounded-3xl border border-border bg-surface", className)}>{children}</section>
);

/** "Market $38,400" with its source label, or "no price" when Scryfall has none for this finish. */
function MarketStat({ c, label = "Market" }: { c: CardData; label?: string }) {
  const usdc = quoteUsdc(c.price);
  const source = c.price && c.card ? priceSourceLabel(c.price, c.card.condition) : null;
  return <Stat label={label} value={usdc != null ? money(usdc, 0) : c.price ? "no price" : "…"} sub={source ?? "Scryfall USD"} />;
}

/**
 * Whole card, viewed by its owner (yV8eD): "You own 100%", the market price, "Shard this card" and "Pick it up at the
 * vault" (an info sheet about the Passport handover; no transaction).
 */
export function OwnerPanel({ c }: { c: CardData }) {
  const [pickup, setPickup] = useState(false);
  const id = c.card!.id.toString();
  return (
    // Mobile (yV8eD): stats unboxed, the two CTAs pinned to the bottom of the screen.
    <Panel className="flex flex-col gap-6 p-6 max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:p-0 md:p-7">
      <div className="grid grid-cols-2 gap-6">
        <Stat label="You own" value="100%" sub="Whole card, in the vault" />
        <MarketStat c={c} />
      </div>
      <div className="flex flex-col gap-3 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:border-t max-md:border-border max-md:bg-bg/95 max-md:px-4 max-md:pt-4 max-md:pb-[calc(1rem+env(safe-area-inset-bottom))] max-md:backdrop-blur sm:flex-row">
        <Button asChild variant="primary" size="md" className="sm:flex-1">
          <Link href={`/app/cards/${id}/shard`}><LayersIcon aria-hidden />Shard this card</Link>
        </Button>
        <Button variant="secondary" size="md" className="sm:flex-1" onClick={() => setPickup(true)}>
          <PackageIcon aria-hidden />Pick it up at the vault
        </Button>
      </div>
      <Sheet open={pickup} onOpenChange={setPickup}>
        <SheetContent side="bottom" className="mx-auto max-w-lg rounded-t-3xl border-border bg-surface p-6">
          <SheetHeader className="p-0">
            <SheetTitle className="font-display text-[22px] text-text">Pick it up at the vault</SheetTitle>
            <SheetDescription className="text-[14px] text-text-2">
              Bring your Passport to the Kura counter in Tokyo. The vendor checks it against this wallet and hands you the card.
            </SheetDescription>
          </SheetHeader>
          <ul className="mt-4 flex list-disc flex-col gap-2 pl-5 text-[13px] text-text-2">
            <li>Nothing to sign here: the vendor releases the card on chain at the counter.</li>
            <li>Once released, the card leaves the vault and its name is revoked. The token stays as a record.</li>
            <li>A card that is sharded can only be picked up by a holder of 80% or more, after a buyout.</li>
          </ul>
          <Button variant="secondary" size="md" className="mt-6 w-full" onClick={() => setPickup(false)}>Got it</Button>
        </SheetContent>
      </Sheet>
    </Panel>
  );
}

/** Whole card, viewed by anyone else: who owns it and its market price. No CTA. */
export function OwnedByPanel({ c }: { c: CardData }) {
  return (
    <Panel className="grid grid-cols-1 gap-6 p-6 sm:grid-cols-2 md:p-7">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[12px] tracking-[0.5px] text-muted-foreground uppercase">Owned by</span>
        <AddressName address={c.card!.ownerOf} className="[&>span:nth-child(2)]:text-[18px]" />
        <span className="text-[12px] text-text-2">Whole card, not sharded</span>
      </div>
      <MarketStat c={c} />
    </Panel>
  );
}

/** Live auction summary. The full auction panel (chart, bid form) is the Auction tab's (Task 6). */
export function AuctionSummary({ c, block, auctionHref }: { c: CardData; block: bigint | null; auctionHref: string }) {
  const s = c.sharding!;
  const lastTick = c.ticks.filter((t) => t.auction === s.auction).at(-1);
  const clearing = q96ToUsdcPerShard(s.clearingPriceQ96 ?? lastTick?.clearingPriceQ96 ?? s.floorPriceQ96);
  const raised = lastTick?.currencyRaised ?? 0n;
  const market = quoteUsdc(c.price);
  const vs = vsMarket(clearing, market, s.totalShards);
  const left = block != null ? s.endBlock - block : null;
  return (
    <Panel className="flex flex-col gap-6 p-6 md:p-7">
      <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
        <Stat label="Clearing price" value={money(clearing, 0)} sub={`per shard · floor ${money(q96ToUsdcPerShard(s.floorPriceQ96), 0)}`} />
        <Stat label="Raised" value={money(raised, 0)} sub={`${s.forSale} of ${s.totalShards} shards for sale`} />
        <Stat label="Ends in" value={left == null ? "…" : left > 0n ? countdown(left) : "ended"} tone="shu" sub={`block ${s.endBlock.toLocaleString("en-US")}`} />
        <Stat
          label="VS market"
          value={vs == null ? "n/a" : `${vs >= 0 ? "+" : ""}${(vs * 100).toFixed(1)}%`}
          tone={vs != null && vs >= 0 ? "good" : undefined}
          sub={market != null ? `Scryfall ${money(market, 0)} / ${s.totalShards}` : "no market price"}
        />
      </div>
      <Button asChild variant="primary" size="md" className="w-full sm:w-fit"><Link href={auctionHref}>Open the auction</Link></Button>
    </Panel>
  );
}

/** Settled sharding summary. The redeem panel (Task 7) takes this slot. */
export function ShardedSummary({ c }: { c: CardData }) {
  const s = c.sharding!;
  const clearing = s.clearingPriceQ96 != null && s.graduated !== false ? q96ToUsdcPerShard(s.clearingPriceQ96) : null;
  const mine = c.myBalance;
  return (
    <Panel className="flex flex-col gap-6 p-6 md:p-7">
      {mine > 0n && (
        <p className="text-[14px] text-text-2">
          You hold <span className="font-mono text-text">{shardsFixed(mine)}</span> of {s.totalShards} shards.
        </p>
      )}
      <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
        <Stat label="Auction clearing" value={clearing != null ? money(clearing, 0) : "n/a"} sub={s.graduated === false ? "Reserve not met · refunded" : "per shard"} />
        <Stat label="Raised" value={money(s.raisedUsdc ?? 0n, 0)} sub={`fee ${money(s.feeUsdc ?? 0n)}`} />
        <Stat label="Shards" value={String(s.totalShards)} sub="Redeem at 80%" />
        <MarketStat c={c} />
      </div>
    </Panel>
  );
}

/** A bought-out sharding's auction, shown as history on a card that is whole again. */
export function PastAuction({ s, settledAt }: { s: ShardingRow; settledAt: string | null }) {
  const clearing = s.clearingPriceQ96 != null && s.graduated !== false ? q96ToUsdcPerShard(s.clearingPriceQ96) : null;
  return (
    <Panel className="flex flex-col gap-6 p-6 md:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-text-2">Past auction · history</h2>
        {settledAt && <span className="text-[12px] text-muted-foreground">settled {settledAt}</span>}
      </div>
      <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
        <Stat label="Clearing" value={clearing != null ? money(clearing, 0) : "n/a"} sub={s.graduated === false ? "Reserve not met · refunded" : "per shard"} />
        <Stat label="Raised" value={money(s.raisedUsdc ?? 0n, 0)} sub={`fee ${money(s.feeUsdc ?? 0n)}`} />
        <Stat label="Shards" value={String(s.totalShards)} sub={`${s.forSale} were for sale`} />
        <Stat label="Buyout" value={s.buyoutPerShard != null ? `${money(s.buyoutPerShard, 0)} / shard` : "n/a"} sub={s.payoutUsdc != null ? `paid ${money(s.payoutUsdc, 0)}` : undefined} />
      </div>
    </Panel>
  );
}

/** Released: the card left the vault. Task 8 fills in the handover details. */
export function ReleasedSummary({ c }: { c: CardData }) {
  const s = c.sharding;
  const release = c.activities.find((a) => a.kind === "release");
  return (
    <Panel className="flex flex-col gap-5 p-6 md:p-7">
      <div className="flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-good-soft text-good-fg"><PackageCheckIcon aria-hidden className="size-6" /></span>
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-[26px] font-semibold text-text">This card left the vault</h2>
          <p className="inline-flex flex-wrap items-center gap-1 text-[14px] text-text-2">
            Handed to <AddressName address={c.card!.beneficialOwner} avatar={false} copyable={false} className="[&>span]:font-sans [&>span]:text-[14px] [&>span]:text-text-2" /> at the Tokyo counter{release ? ` on ${dateTime(release.timestamp)}` : ""}, after a Passport check.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 rounded-2xl bg-bg/60 p-4 lg:grid-cols-4">
        <Stat small label="Final buyout" value={s?.buyoutPerShard != null ? `${money(s.buyoutPerShard, 0)} / shard` : "n/a"} />
        <Stat small label="Paid to holders" value={s?.payoutUsdc != null ? money(s.payoutUsdc, 0) : "n/a"} />
        <Stat small label="Release tx" value={release ? <a href={explorerTx(release.txHash)} target="_blank" rel="noreferrer" className="hover:underline">{shortHash(release.txHash)}</a> : "n/a"} />
        <Stat small label="Token" value="kept as a record" />
      </div>
      <p className="text-[13px] text-text-2">Nothing more can be sharded or bid here. Holders who haven&apos;t claimed their payout still can, from their portfolio.</p>
    </Panel>
  );
}
