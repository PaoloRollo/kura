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

/**
 * Owner · Auction settled (Oh2m9). Graduated: the net proceeds and the vault's half of the shards opened the Uniswap
 * pool at the clearing price, and the seller earns its fees. Not graduated: every shard went back to the seller.
 */
export function OwnerSettled({ info, cardName, sold, buyers, onClose }: { info: SettledInfo; cardName: string; sold: number | null; buyers: number; onClose: () => void }) {
  const net = info.raisedUsdc - info.feeUsdc;
  const clearing = q96ToUsdcPerShard(info.clearingQ96);
  const feePct = info.raisedUsdc > 0n ? Number((info.feeUsdc * 10_000n) / info.raisedUsdc) / 100 : null;
  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col items-center gap-5 py-6 text-center" aria-live="polite">
      <span className="flex size-[120px] items-center justify-center rounded-full border-2 border-good bg-good-soft text-good-fg">
        <CheckCheckIcon aria-hidden className="size-12" strokeWidth={2.25} />
      </span>
      {info.graduated && <div className="font-mono text-[44px] leading-none text-text">{money(clearing)}</div>}
      <h1 className="font-display text-[28px] leading-tight font-semibold text-text">
        {info.graduated ? `Pool opened at ${money(clearing)} / shard` : "Your auction didn't reach its reserve"}
      </h1>
      <p className="max-w-[420px] text-[14px] text-text-2">
        {info.graduated
          ? `${sold != null ? `${sold} ` : ""}${cardName} shards sold at ${money(clearing)} to ${buyers} verified ${buyers === 1 ? "human" : "humans"}. ${money(info.raisedUsdc)} raised and ${money(info.feeUsdc)} went to the vault. The rest and the other half of the shards opened a Uniswap pool at the clearing price. You earn the pool's trading fees until the card is bought out.`
          : `Nothing was sold and no fee was charged. No pool was opened: every shard is back in your wallet, and every bidder can take back their budget.`}
      </p>
      <a href={explorerTx(info.hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text-2 hover:text-text">
        settle {shortHash(info.hash)}<ExternalLinkIcon aria-hidden className="size-3" />
      </a>
      {info.graduated && (
        <div className="w-full rounded-2xl border border-border bg-surface text-[14px]">
          <div className="flex justify-between border-b border-border px-4 py-3"><span className="text-text-2">Raised</span><span className="font-mono text-text">{money(info.raisedUsdc)}</span></div>
          <div className="flex justify-between border-b border-border px-4 py-3"><span className="text-text-2">Vault fee{feePct != null ? ` ${feePct}%` : ""}</span><span className="font-mono text-text">-{money(info.feeUsdc)}</span></div>
          <div className="flex justify-between px-4 py-3"><span className="font-semibold text-text">Into the pool</span><span className="font-mono text-good-fg">{money(net)}</span></div>
        </div>
      )}
      <div className="flex w-full flex-col gap-2.5 pt-4">
        <Button variant="primary" size="md" className="h-12 w-full rounded-xl" onClick={onClose}><ArrowRightIcon aria-hidden />See {cardName}</Button>
        <Button asChild variant="secondary" size="md" className="h-12 w-full rounded-xl"><Link href="/app/portfolio?tab=whole" onClick={() => showOwnerSettled(null)}>Open another auction</Link></Button>
      </div>
    </div>
  );
}
