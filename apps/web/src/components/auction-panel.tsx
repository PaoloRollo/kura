"use client";

import { useState } from "react";
import { GavelIcon } from "lucide-react";
import type { Address } from "viem";
import { q96ToUsdcPerShard } from "@kura/shared";
import { Button } from "@/components/kura";
import { useAuctionChain, type AuctionChain } from "@/components/auction-io";
import { BidForm } from "@/components/bid-form";
import { Panel, Stat } from "@/components/card-state-panel";
import { useIsDesktop } from "@/components/tx-stepper";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { CardData, CheckpointRow, ShardingRow } from "@/hooks/use-card";
import { demandRatio } from "@/lib/bid-math";
import { countdown, money } from "@/lib/format";
import { marketPerShard, quoteUsdc, vsMarket } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/** The live clearing price: the chain's, else the indexer's latest checkpoint, else the sharding row, else the floor. */
export function liveClearingQ96(s: ShardingRow, checkpoints: readonly CheckpointRow[], chain: Pick<AuctionChain, "clearingQ96">): bigint {
  return chain.clearingQ96 ?? checkpoints.at(-1)?.clearingPriceQ96 ?? s.clearingPriceQ96 ?? s.floorPriceQ96;
}

const pctText = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

/** The stats strip (HisVE): clearing, raised, time left and the premium over the market reference. */
function AuctionStats({ c, s, clearingUsdc, raised, left }: { c: CardData; s: ShardingRow; clearingUsdc: bigint; raised: bigint; left: bigint | null }) {
  const market = quoteUsdc(c.price);
  const vs = vsMarket(clearingUsdc, market, s.totalShards);
  const openBudgets = c.bids.filter((b) => b.auction === s.auction && b.status === "open").reduce((a, b) => a + b.amountUsdc, 0n);
  const demand = demandRatio(openBudgets, clearingUsdc, s.forSale);
  return (
    <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
      <Stat label="Clearing price" value={money(clearingUsdc, 0)} sub={`per shard · floor ${money(q96ToUsdcPerShard(s.floorPriceQ96), 0)}`} />
      <Stat label="Raised" value={money(raised, 0)} sub={demand != null ? `demand ${demand.toFixed(1)}× supply` : `${s.forSale} shards for sale`} />
      <Stat label="Ends in" value={left == null ? "…" : countdown(left)} tone="shu" sub={`block ${s.endBlock.toLocaleString("en-US")}`} />
      <Stat
        label="VS market"
        value={vs == null ? "n/a" : pctText(vs)}
        tone={vs != null && vs >= 0 ? "good" : "shu"}
        sub={market != null ? `Scryfall ${money(market, 0)} / ${s.totalShards}` : "no market price"}
      />
    </div>
  );
}

/** "Clearing price, per block" (HisVE): one bar per checkpoint, the latest brighter, and the dashed market line. */
export function ClearingChart({ s, checkpoints, clearingUsdc, marketUsdc }: { s: ShardingRow; checkpoints: readonly CheckpointRow[]; clearingUsdc: bigint; marketUsdc: bigint | null }) {
  const floor = q96ToUsdcPerShard(s.floorPriceQ96);
  const prices = checkpoints.slice(-24).map((cp) => q96ToUsdcPerShard(cp.clearingPriceQ96));
  if (prices.length === 0) prices.push(clearingUsdc);
  const all = [...prices, floor, ...(marketUsdc ? [marketUsdc] : [])];
  const hi = all.reduce((a, b) => (b > a ? b : a), 0n);
  const lo = all.reduce((a, b) => (b < a ? b : a), hi);
  // Bars start below the lowest value so the floor still shows as a bar; the top leaves a little headroom.
  const base = Number(lo) * 0.85;
  const span = Math.max(1, Number(hi) * 1.04 - base);
  const h = (v: bigint) => `${Math.max(4, ((Number(v) - base) / span) * 100)}%`;
  const vs = vsMarket(clearingUsdc, marketUsdc ? marketUsdc * BigInt(s.totalShards) : null, s.totalShards);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-text">Clearing price, per block</h3>
        <div className="flex items-center gap-4 text-[12px] text-text-2">
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-[3px] w-2.5 rounded-full bg-s1" />Clearing</span>
          {marketUsdc && <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-[3px] w-2.5 rounded-full bg-shu" />Market / {s.totalShards}</span>}
        </div>
      </div>
      <div className="relative h-[170px]" role="img" aria-label={`Clearing price from ${money(prices[0]!, 0)} to ${money(clearingUsdc, 0)} per shard`}>
        <div className="flex h-full items-end gap-1">
          {prices.map((p, i) => (
            <span key={i} className={cn("min-w-0 flex-1 rounded-t-[3px]", i === prices.length - 1 ? "bg-s1" : "bg-s1/45")} style={{ height: h(p) }} />
          ))}
        </div>
        {marketUsdc && <span aria-hidden className="absolute inset-x-0 border-t-2 border-dashed border-shu" style={{ bottom: h(marketUsdc) }} />}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>start · {money(floor, 0)}</span>
        <span>now · {money(clearingUsdc, 0)}</span>
      </div>
      {marketUsdc && vs != null && (
        <p className="flex items-center gap-2 text-[12px] text-text-2">
          <span aria-hidden className="h-[3px] w-2.5 shrink-0 rounded-full bg-shu" />
          Market reference {money(marketUsdc)} per shard, clearing is {Math.abs(vs * 100).toFixed(1)}% {vs >= 0 ? "above" : "below"}
        </p>
      )}
    </div>
  );
}

/** The live auction (HisVE; aD9is on mobile): stats, the clearing chart and the bid form, a bottom sheet below `md`. */
function LiveAuction({ c, me, block, chain }: { c: CardData; me: Address | null; block: bigint | null; chain: AuctionChain }) {
  const s = c.sharding!;
  const isDesktop = useIsDesktop();
  const [sheet, setSheet] = useState(false);
  const clearingQ96 = liveClearingQ96(s, c.checkpoints, chain);
  const clearingUsdc = q96ToUsdcPerShard(clearingQ96);
  const raised = chain.raised ?? c.ticks.filter((t) => t.auction === s.auction).at(-1)?.currencyRaised ?? 0n;
  const left = block != null ? s.endBlock - block : null;
  const market = marketPerShard(quoteUsdc(c.price), s.totalShards);
  const form = <BidForm sharding={s} me={me} chain={chain} clearingQ96={clearingQ96} />;
  return (
    <Panel className="flex flex-col">
      <div className="border-b border-border p-6 md:p-7">
        <AuctionStats c={c} s={s} clearingUsdc={clearingUsdc} raised={raised} left={left} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="p-6 md:p-7 lg:border-r lg:border-border">
          <ClearingChart s={s} checkpoints={c.checkpoints} clearingUsdc={clearingUsdc} marketUsdc={market} />
        </div>
        {isDesktop ? (
          <div className="p-6 md:p-7">{form}</div>
        ) : (
          <>
            <div className="p-6 pt-0">
              <Button variant="primary" size="md" className="h-12 w-full rounded-xl text-[15px]" onClick={() => setSheet(true)}><GavelIcon aria-hidden />Place a bid</Button>
            </div>
            <Sheet open={sheet} onOpenChange={setSheet}>
              <SheetContent side="bottom" showCloseButton={false} className="max-h-[92dvh] overflow-y-auto rounded-t-3xl border-border bg-surface px-5 pt-3 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
                <span aria-hidden className="mx-auto h-1 w-9 rounded-full bg-border" />
                <div className="flex items-baseline justify-between gap-3 pt-3">
                  <SheetTitle className="font-display text-[24px] font-semibold text-text">Bid on {s.forSale} shards</SheetTitle>
                  <span className="shrink-0 font-mono text-[13px] text-shu">{left == null ? "…" : `${countdown(left)} left`}</span>
                </div>
                <SheetDescription className="sr-only">Place a bid on this auction</SheetDescription>
                <div className="pt-4">{form}</div>
              </SheetContent>
            </Sheet>
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * The card's auction (HisVE while it runs). Ended is decided by the polled block (`block >= endBlock`): an
 * activeAuctions row outlives endBlock until someone settles.
 */
export function AuctionPanel({ c, me, block }: { c: CardData; me: Address | null; block: bigint | null }) {
  const s = c.sharding!;
  const ended = block != null && block >= s.endBlock;
  const chain = useAuctionChain(s.auction as Address, me, ended || s.settled);
  if (!ended && !s.settled) return <LiveAuction c={c} me={me} block={block} chain={chain} />;
  return (
    <Panel className="p-6 md:p-7">
      <h2 className="font-display text-[22px] font-semibold text-text">The auction has ended</h2>
      <p className="mt-1 text-[13px] text-text-2">Settling, exits and claims open here once the auction is over.</p>
    </Panel>
  );
}
