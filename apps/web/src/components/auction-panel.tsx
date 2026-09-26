"use client";

import { useRef, useState } from "react";
import { CheckCheckIcon, CheckIcon, ExternalLinkIcon, GavelIcon } from "lucide-react";
import type { Address, Hex, TransactionReceipt } from "viem";
import { abi, q96ToUsdcPerShard } from "@kura/shared";
import { Button, Pill, notify } from "@/components/kura";
import { useAuctionChain, useAuctionIo, type AuctionChain } from "@/components/auction-io";
import { BidForm } from "@/components/bid-form";
import { Panel, Stat } from "@/components/card-state-panel";
import { MyBids } from "@/components/my-bids";
import { settledFromReceipt, showOwnerSettled } from "@/components/settle-success";
import { TxStepper, useIsDesktop } from "@/components/tx-stepper";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { CardData, CheckpointRow, ShardingRow } from "@/hooks/use-card";
import { bidView, demandRatio } from "@/lib/bid-math";
import { addresses, explorerTx } from "@/lib/chain";
import { countdown, money, shortHash } from "@/lib/format";
import type { Step } from "@/lib/tx-core";
import { marketPerShard, quoteUsdc, vsMarket } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/** The live clearing price: the chain's, else the indexer's latest checkpoint, else the sharding row, else the floor. */
export function liveClearingQ96(s: ShardingRow, checkpoints: readonly CheckpointRow[], chain: Pick<AuctionChain, "clearingQ96">): bigint {
  return chain.clearingQ96 ?? checkpoints.at(-1)?.clearingPriceQ96 ?? s.clearingPriceQ96 ?? s.floorPriceQ96;
}

const SHARD = 10n ** 18n;
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

const AUCTIONING = 2; // CardVault.State.Auctioning

/**
 * After the end block (PA50F, oz3mH): the outcome, the permissionless Settle, and my bids with their exit and claim.
 * Before settle the outcome comes from `isGraduated()` / `clearingPrice()` / `currencyRaised()`, which only reach their
 * final values at the first checkpoint after the end block (settle writes it), so exits wait for settle.
 */
function PostAuction({ c, me, chain }: { c: CardData; me: Address | null; chain: AuctionChain }) {
  const s = c.sharding!;
  const io = useAuctionIo();
  const receipt = useRef<TransactionReceipt | null>(null);
  const [settledHash, setSettledHash] = useState<Hex | null>(null);
  const graduated = s.settled ? s.graduated : chain.graduated;
  const clearingQ96 = (s.settled ? s.clearingPriceQ96 : null) ?? liveClearingQ96(s, c.checkpoints, chain);
  const lastTick = c.ticks.filter((t) => t.auction === s.auction).at(-1);
  const raised = s.settled && s.graduated ? (s.raisedUsdc ?? 0n) : (chain.raised ?? lastTick?.currencyRaised ?? 0n);
  const sold = chain.cleared != null ? Number((chain.cleared + SHARD / 2n) / SHARD) : null;
  const mine = c.bids.filter((b) => b.auction === s.auction && !!me && b.owner.toLowerCase() === me.toLowerCase());
  const isOwner = !!me && c.card!.beneficialOwner.toLowerCase() === me.toLowerCase();

  const settleSteps: Step[] = [
    {
      id: "settle",
      label: graduated === false ? "Settle: return the shards, open refunds" : "Settle: pay the owner and the vault, return unsold shards",
      skip: async () => (await io.read<{ state: number }>({ address: addresses.cardVault, abi: abi.cardVault, functionName: "cards", args: [s.cardId] })).state !== AUCTIONING,
      run: async () => {
        const sent = await io.send({ to: addresses.cardVault, abi: abi.cardVault, functionName: "settle", args: [s.cardId] });
        receipt.current = sent.receipt;
        return sent;
      },
    },
  ];

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Panel className="flex flex-col gap-2 p-6 md:p-7">
        {graduated === false ? (
          <>
            <Pill tone="live" dot={false}>Reserve not met</Pill>
            <p className="font-mono text-[20px] text-text md:text-[26px]">Raised {money(raised, 0)} of {money(s.reserveUsdc, 0)}</p>
            <p className="text-[13px] text-text-2">The auction didn&apos;t graduate. Nothing was sold.</p>
          </>
        ) : graduated ? (
          <>
            <Pill tone="released" dot={false}>Auction graduated</Pill>
            <p className="font-mono text-[20px] text-text md:text-[26px]">Cleared at {money(q96ToUsdcPerShard(clearingQ96), 0)} / shard</p>
            <p className="text-[13px] text-text-2">{sold != null ? `${sold} of ${s.forSale} shards sold · ` : ""}{money(raised, 0)} raised</p>
          </>
        ) : (
          <>
            <Pill dot={false}>Auction ended</Pill>
            <p className="font-mono text-[20px] text-text md:text-[26px]">Clearing {money(q96ToUsdcPerShard(clearingQ96), 0)} / shard</p>
            <p className="text-[13px] text-text-2">Reading the outcome…</p>
          </>
        )}
      </Panel>

      {!s.settled && (
        <Panel className="flex flex-col gap-4 p-5 md:p-6">
          <div className="flex flex-col gap-1">
            <h3 className="text-[15px] font-semibold text-text">{graduated === false ? "Settle and refund" : "Settle the auction"}</h3>
            <p className="text-[13px] text-text-2">
              {graduated === false
                ? `Returns all ${s.forSale} shards to the owner. Every bidder can then take back their full budget. No fee is charged.`
                : "Pays the owner, pays the vault fee, returns any unsold shards. Anyone can do it."}
            </p>
          </div>
          <TxStepper
            cta={graduated === false ? "Settle and refund" : "Settle"}
            ctaIcon={<CheckCheckIcon aria-hidden />}
            ctaClassName="h-12 rounded-xl bg-text text-bg hover:bg-text/90"
            title="Settling the auction"
            failedTitle="The auction didn't settle"
            steps={settleSteps}
            walletKind={io.walletKind}
            successToast={false}
            onDone={(results) => {
              const hash = results.find((r) => r.id === "settle")?.hash ?? null;
              const info = receipt.current ? settledFromReceipt(s.cardId, receipt.current) : null;
              notify({ title: "Auction settled", body: info && !info.graduated ? "Reserve not met: bidders can take back their budgets." : "The owner and the vault were paid.", tone: "good", icon: <CheckIcon /> });
              setSettledHash(hash);
              if (info && isOwner) showOwnerSettled(info);
            }}
          />
        </Panel>
      )}
      {settledHash && (
        <a href={explorerTx(settledHash)} target="_blank" rel="noreferrer" aria-live="polite" className="inline-flex w-fit items-center gap-1.5 rounded-full bg-good-soft px-3 py-1.5 font-mono text-[12px] text-good-fg hover:underline">
          settled · {shortHash(settledHash)}<ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-[24px] font-semibold text-text">Your bids</h2>
        <MyBids bids={mine} auction={s.auction as Address} ended settled={s.settled} graduated={graduated} clearingQ96={clearingQ96} checkpoints={c.checkpoints} />
      </section>
    </div>
  );
}

/** Whether `me` still has something to do on the card's current auction (exit, claim or take back). */
export function hasBidActions(c: CardData, me: string | null, graduated: boolean | null): boolean {
  const s = c.sharding;
  if (!s || !me || !s.settled) return false;
  const clearingQ96 = s.clearingPriceQ96 ?? s.floorPriceQ96;
  return c.bids.some((b) => b.auction === s.auction && b.owner.toLowerCase() === me.toLowerCase() && bidView(b, { ended: true, graduated: graduated ?? s.graduated, clearingQ96 }).action !== "none");
}

/**
 * The card's auction: HisVE while it runs, PA50F / oz3mH after the end block. Ended is decided by the polled block (`block >= endBlock`): an
 * activeAuctions row outlives endBlock until someone settles.
 */
export function AuctionPanel({ c, me, block }: { c: CardData; me: Address | null; block: bigint | null }) {
  const s = c.sharding!;
  const ended = s.settled || (block != null && block >= s.endBlock);
  const chain = useAuctionChain(s.auction as Address, me, ended);
  if (!ended) return <LiveAuction c={c} me={me} block={block} chain={chain} />;
  return <PostAuction c={c} me={me} chain={chain} />;
}
