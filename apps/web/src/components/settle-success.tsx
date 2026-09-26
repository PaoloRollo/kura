"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRightIcon, CheckCheckIcon, ExternalLinkIcon } from "lucide-react";
import { parseEventLogs, type Hex, type TransactionReceipt } from "viem";
import { abi, q96ToUsdcPerShard } from "@kura/shared";
import { Button } from "@/components/kura";
import { explorerTx } from "@/lib/chain";
import { money, shortHash } from "@/lib/format";

/** What the seller sees after settling (Oh2m9), from the AuctionSettled log of the settle receipt. */
export type SettledInfo = { cardId: bigint; hash: Hex; raisedUsdc: bigint; feeUsdc: bigint; graduated: boolean; clearingQ96: bigint; /** Whole shards sold, from `totalCleared()`. */ sold: number | null };

/** AuctionSettled from a settle receipt, or null when the receipt has none for `cardId`. */
export function settledFromReceipt(cardId: bigint, receipt: Pick<TransactionReceipt, "logs" | "transactionHash">, sold: number | null = null): SettledInfo | null {
  const ev = parseEventLogs({ abi: abi.cardVault, eventName: "AuctionSettled", logs: receipt.logs }).find((l) => l.args.id === cardId);
  if (!ev) return null;
  return { cardId, hash: receipt.transactionHash, raisedUsdc: ev.args.raisedUsdc, feeUsdc: ev.args.feeUsdc, graduated: ev.args.graduated, clearingQ96: ev.args.clearingPriceQ96, sold: ev.args.graduated ? sold : null };
}

// The success outlives the auction panel: once settled, the card page swaps that panel for the sharded summary.
let current: SettledInfo | null = null;
const listeners = new Set<() => void>();
export function showOwnerSettled(info: SettledInfo | null) {
  current = info;
  listeners.forEach((l) => l());
}
export function useOwnerSettled(cardId: bigint | undefined): SettledInfo | null {
  const v = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
  return v && cardId !== undefined && v.cardId === cardId ? v : null;
}

/** Owner · Auction settled (Oh2m9): what reached the seller's wallet, the settle tx and the way on. */
export function OwnerSettled({ info, cardName, sold, buyers, onClose }: { info: SettledInfo; cardName: string; sold: number | null; buyers: number; onClose: () => void }) {
  const toYou = info.raisedUsdc - info.feeUsdc;
  const feePct = info.raisedUsdc > 0n ? Number((info.feeUsdc * 10_000n) / info.raisedUsdc) / 100 : null;
  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col items-center gap-5 py-6 text-center" aria-live="polite">
      <span className="flex size-[120px] items-center justify-center rounded-full border-2 border-good bg-good-soft text-good-fg">
        <CheckCheckIcon aria-hidden className="size-12" strokeWidth={2.25} />
      </span>
      <div className="font-mono text-[44px] leading-none text-text">+{money(toYou)}</div>
      <h1 className="font-display text-[28px] leading-tight font-semibold text-text">{info.graduated ? "Your auction settled" : "Your auction didn't reach its reserve"}</h1>
      <p className="max-w-[420px] text-[14px] text-text-2">
        {info.graduated
          ? `${sold != null ? `${sold} ` : ""}${cardName} shards sold at ${money(q96ToUsdcPerShard(info.clearingQ96), 0)} to ${buyers} verified ${buyers === 1 ? "human" : "humans"}. ${money(info.raisedUsdc)} raised, ${money(info.feeUsdc)} went to the vault, the rest is in your wallet.`
          : `Nothing was sold and no fee was charged. The shards for sale are back in your wallet, and every bidder can take back their budget.`}
      </p>
      <a href={explorerTx(info.hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text-2 hover:text-text">
        settle {shortHash(info.hash)}<ExternalLinkIcon aria-hidden className="size-3" />
      </a>
      <div className="w-full rounded-2xl border border-border bg-surface text-[14px]">
        <div className="flex justify-between border-b border-border px-4 py-3"><span className="text-text-2">Raised</span><span className="font-mono text-text">{money(info.raisedUsdc)}</span></div>
        <div className="flex justify-between border-b border-border px-4 py-3"><span className="text-text-2">Vault fee{feePct != null ? ` ${feePct}%` : ""}</span><span className="font-mono text-text">-{money(info.feeUsdc)}</span></div>
        <div className="flex justify-between px-4 py-3"><span className="font-semibold text-text">To you</span><span className="font-mono text-good-fg">{money(toYou)}</span></div>
      </div>
      <div className="flex w-full flex-col gap-2.5 pt-4">
        <Button variant="primary" size="md" className="h-12 w-full rounded-xl" onClick={onClose}><ArrowRightIcon aria-hidden />See {cardName}</Button>
        <Button asChild variant="secondary" size="md" className="h-12 w-full rounded-xl"><Link href="/app/portfolio?tab=whole">Open another auction</Link></Button>
      </div>
    </div>
  );
}
