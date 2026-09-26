"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import type { Address, Hex } from "viem";
import { abi, q96ToUsdcPerShard } from "@kura/shared";
import { useAuctionIo } from "@/components/auction-io";
import { TxStepper, describeTxError } from "@/components/tx-stepper";
import type { BidRow, CheckpointRow } from "@/hooks/use-card";
import { bidView, exitRevertMessage, exitRoute, type BidView } from "@/lib/bid-math";
import { explorerTx } from "@/lib/chain";
import { money, shardsFixed, shortHash } from "@/lib/format";
import { TxError, type Step } from "@/lib/tx-core";
import { cn } from "@/lib/utils";

/** TxStepper's CTA in the Button/Secondary look (Exit, Take back). */
export const SECONDARY_CTA = "h-11 rounded-xl border border-border bg-secondary text-text hover:bg-surface-2";

const TONE: Record<BidView["tone"], string> = { good: "text-good-fg", kin: "text-kin", muted: "text-muted-foreground", shu: "text-shu" };

type OnChainBid = { exitedBlock: bigint; tokensFilled: bigint };

export type MyBidsProps = {
  bids: readonly BidRow[];
  auction: Address;
  /** block >= endBlock */
  ended: boolean;
  settled: boolean;
  /** Known once ended: the settled row's, else `isGraduated()`. */
  graduated: boolean | null;
  /** The final clearing price once ended (the current one before). */
  clearingQ96: bigint;
  /** The auction's checkpoints, oldest first (the exit hints). */
  checkpoints: readonly CheckpointRow[];
};

/** "Your bids" (PA50F, oz3mH): each bid's state and its next step (exit then claim, or take back). */
export function MyBids({ bids, ...p }: MyBidsProps) {
  if (bids.length === 0) return <p className="text-[13px] text-text-2">You have no bids on this auction.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {bids.map((b) => <BidItem key={b.id} b={b} {...p} />)}
    </ul>
  );
}

function detail(b: BidRow, v: BidView, p: Omit<MyBidsProps, "bids">): { line: string; note?: string } {
  const filled = b.tokensFilled ?? 0n;
  const refund = money(b.currencyRefunded ?? 0n);
  if (b.status === "claimed") return { line: `Filled ${shardsFixed(filled, 2)} shards · refund ${refund}`, note: "Shards in your wallet" };
  if (b.status === "exited") {
    if (filled > 0n) return { line: `Filled ${shardsFixed(filled, 2)} shards · refund ${refund}` };
    return p.graduated === false ? { line: `Full refund ${refund} · taken back`, note: "Refund received" } : { line: `Outbid · refund ${refund}`, note: "Refund received" };
  }
  if (!p.ended) {
    if (v.label === "outbid") return { line: `Outbid at ${money(q96ToUsdcPerShard(p.clearingQ96))}. Shards filled before that are kept; the unspent budget comes back when you exit after the auction.` };
    if (v.label === "at clearing · filling") return { line: "At the clearing price: filling alongside the other bids at this price." };
    return { line: `In while the price stays below ${money(q96ToUsdcPerShard(b.maxPriceQ96))}` };
  }
  if (p.graduated === false) return { line: `Full refund ${money(b.amountUsdc)}` };
  if (v.label === "outbid") return { line: "Outbid at the final price. Exit to keep any shards filled before that and take back the rest." };
  return { line: "Exit to lock in your shards and get back what wasn't spent." };
}

function BidItem({ b, auction, ended, settled, graduated, clearingQ96, checkpoints }: { b: BidRow } & Omit<MyBidsProps, "bids">) {
  const io = useAuctionIo();
  const v = bidView({ status: b.status, maxPriceQ96: b.maxPriceQ96, tokensFilled: b.tokensFilled }, { ended, graduated, clearingQ96 });
  const d = detail(b, v, { auction, ended, settled, graduated, clearingQ96, checkpoints });
  const [sent, setSent] = useState<{ label: string; hash: Hex } | null>(null);
  // The steps read the hints when they run: the indexer may have caught up since the steps were built.
  const cps = useRef(checkpoints);
  useEffect(() => {
    cps.current = checkpoints;
  }, [checkpoints]);

  const readBid = () => io.read<OnChainBid>({ address: auction, abi: abi.ccaAuction, functionName: "bids", args: [b.bidId] });
  const exitStep: Step = {
    id: `exit-${b.id}`,
    label: v.action === "take-back" ? `Take back ${money(b.amountUsdc)}` : "1 · Exit bid",
    skip: async () => (await readBid()).exitedBlock !== 0n,
    run: async () => {
      const route = exitRoute({ bidId: b.bidId, maxPriceQ96: b.maxPriceQ96, submittedBlock: b.submittedBlock }, graduated !== false, cps.current, clearingQ96);
      if (!route) throw new TxError("The indexer is still catching up; try again in a few seconds.");
      return io.send({ to: auction, abi: abi.ccaAuction, functionName: route.fn, args: route.args });
    },
  };
  const claimStep: Step = {
    id: `claim-${b.id}`,
    label: "2 · Claim shards",
    // Claimed, or exited with nothing filled: the auction zeroes tokensFilled on claim.
    skip: async () => {
      const onChain = await readBid();
      return onChain.exitedBlock !== 0n && onChain.tokensFilled === 0n;
    },
    run: () => io.send({ to: auction, abi: abi.ccaAuction, functionName: "claimTokens", args: [b.bidId] }),
  };
  const common = {
    walletKind: io.walletKind,
    failedTitle: "That didn't go through",
    describeError: (e: unknown, r: Parameters<typeof describeTxError>[1]) => exitRevertMessage(r.inner?.name ?? r.name) ?? describeTxError(e, r),
  };
  const done = (label: string) => (results: { id: string; hash?: Hex }[]) => {
    const hash = [...results].reverse().find((r) => r.hash)?.hash;
    if (hash) setSent({ label, hash });
  };

  const canAct = ended && settled && b.status !== "claimed";
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-mono text-[14px] text-text">
          Bid #{b.bidId.toString()} · {money(b.amountUsdc, 0)} up to {money(q96ToUsdcPerShard(b.maxPriceQ96), 0)}
        </span>
        <span className={cn("shrink-0 text-[12px] font-semibold", TONE[v.tone])}>{v.label}</span>
      </div>
      <p className="text-[13px] text-text-2">{d.line}</p>
      {d.note && <p className="text-[13px] text-muted-foreground">{d.note}</p>}
      {ended && !settled && b.status === "open" && <p className="text-[12px] text-muted-foreground">Exits open once the auction is settled. Anyone can settle it above.</p>}
      {canAct && v.action === "exit-claim" && (
        // PA50F: "1 · Exit bid" then "2 · Claim shards". While one runs it takes the whole row.
        <div className="grid grid-cols-2 gap-2.5 has-[[data-slot=tx-progress]]:grid-cols-1 [&:has([data-slot=tx-progress])>*:not(:has([data-slot=tx-progress]))]:hidden">
          <TxStepper {...common} cta="1 · Exit bid" ctaClassName={SECONDARY_CTA} title="Exiting your bid" steps={[exitStep]} onDone={done("exit")} />
          <TxStepper {...common} cta="2 · Claim shards" ctaClassName="h-11 rounded-xl" title="Claiming your shards" steps={[exitStep, claimStep]} onDone={done("claim")} />
        </div>
      )}
      {canAct && v.action === "claim" && (
        <TxStepper {...common} cta="Claim shards" ctaClassName="h-11 rounded-xl" title="Claiming your shards" steps={[{ ...claimStep, label: `Claim ${shardsFixed(b.tokensFilled ?? 0n, 2)} shards` }]} onDone={done("claim")} />
      )}
      {canAct && v.action === "exit" && (
        // Outbid in a graduated auction: an early part of the bid may still have filled, so claim follows when it did.
        <TxStepper {...common} cta="Exit bid" ctaClassName={SECONDARY_CTA} title="Exiting your bid" steps={[{ ...exitStep, label: "Exit bid" }, { ...claimStep, label: "Claim any filled shards" }]} onDone={done("exit")} />
      )}
      {canAct && v.action === "take-back" && (
        <TxStepper {...common} cta={`Take back ${money(b.amountUsdc, 0)}`} ctaClassName={SECONDARY_CTA} title="Taking back your budget" steps={[exitStep]} onDone={done("refund")} />
      )}
      {sent && (
        <a href={explorerTx(sent.hash)} target="_blank" rel="noreferrer" aria-live="polite" className="inline-flex w-fit items-center gap-1.5 rounded-full bg-good-soft px-3 py-1.5 font-mono text-[12px] text-good-fg hover:underline">
          {sent.label} confirmed · {shortHash(sent.hash)}<ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      )}
    </li>
  );
}
