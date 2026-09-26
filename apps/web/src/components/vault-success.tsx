"use client";

import type * as React from "react";
import { useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRightIcon, CompassIcon, ExternalLinkIcon, HandCoinsIcon, KeyRoundIcon } from "lucide-react";
import { parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import { abi } from "@kura/shared";
import { AddressName } from "@/components/address-name";
import { Button } from "@/components/kura";
import { explorerTx } from "@/lib/chain";
import { money, shardsFixed, shortHash } from "@/lib/format";

type Logs = Pick<TransactionReceipt, "logs" | "transactionHash">;

/** A buyout, from the CardRedeemed log of the redeem receipt. */
export type RedeemedInfo = { kind: "redeemed"; cardId: bigint; hash: Hex; buyoutPerShard: bigint; payoutUsdc: bigint; feeUsdc: bigint; missing: bigint };
/** A minority payout, from the PayoutClaimed log of the claim receipt. */
export type ClaimedInfo = { kind: "claimed"; cardId: bigint; hash: Hex; shardUnits: bigint; usdc: bigint; buyoutPerShard: bigint; redeemer: Address | null };
export type VaultSuccess = RedeemedInfo | ClaimedInfo;

export function redeemedFromReceipt(cardId: bigint, missing: bigint, receipt: Logs): RedeemedInfo | null {
  const ev = parseEventLogs({ abi: abi.cardVault, eventName: "CardRedeemed", logs: receipt.logs }).find((l) => l.args.id === cardId);
  if (!ev) return null;
  return { kind: "redeemed", cardId, hash: receipt.transactionHash, buyoutPerShard: ev.args.buyoutPerShard, payoutUsdc: ev.args.payoutUsdc, feeUsdc: ev.args.feeUsdc, missing };
}

export function claimedFromReceipt(p: { buyoutPerShard: bigint; redeemer: Address | null }, receipt: Logs): ClaimedInfo | null {
  const ev = parseEventLogs({ abi: abi.cardVault, eventName: "PayoutClaimed", logs: receipt.logs })[0];
  if (!ev) return null;
  return { kind: "claimed", cardId: ev.args.id, hash: receipt.transactionHash, shardUnits: ev.args.shardUnits, usdc: ev.args.usdc, ...p };
}

// The success outlives the panel that sent it: after a buyout the card turns Whole and the redeem panel unmounts; after
// a claim the payout panel has nothing left to show. The page renders it until the user moves on.
let current: VaultSuccess | null = null;
const listeners = new Set<() => void>();
export function showVaultSuccess(info: VaultSuccess | null) {
  current = info;
  listeners.forEach((l) => l());
}
export function useVaultSuccess(cardId?: bigint): VaultSuccess | null {
  const v = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
  return v && (cardId === undefined || v.cardId === cardId) ? v : null;
}

function TxChip({ label, hash }: { label: string; hash: string }) {
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text-2 hover:text-text">
      {label} {shortHash(hash)}<ExternalLinkIcon aria-hidden className="size-3" />
    </a>
  );
}

function Shell({ icon, amount, title, children, actions }: { icon: React.ReactNode; amount: string; title: string; children: React.ReactNode; actions: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-[520px] flex-col items-center py-6 text-center max-md:min-h-[calc(100dvh-8rem)]" aria-live="polite">
      <div className="flex flex-1 flex-col items-center justify-center gap-5">
        <span className="flex size-[120px] items-center justify-center rounded-full border-2 border-kin bg-kin-soft text-kin [&_svg]:size-12">{icon}</span>
        <div className="font-mono text-[44px] leading-none text-text">{amount}</div>
        <h1 className="font-display text-[28px] leading-tight font-semibold text-text">{title}</h1>
        {children}
      </div>
      <div className="flex w-full flex-col gap-2.5 pt-8">{actions}</div>
    </div>
  );
}

/** UwCiy: "+$1,840.00 · Payout claimed", who bought the card out and at what price, the tx, and the ways on. */
export function PayoutClaimedView({ info, cardName, onClose }: { info: ClaimedInfo; cardName: string; onClose?: () => void }) {
  const units = shardsFixed(info.shardUnits);
  return (
    <Shell
      icon={<HandCoinsIcon aria-hidden strokeWidth={1.75} />}
      amount={`+${money(info.usdc)}`}
      title="Payout claimed"
      actions={
        <>
          <Button asChild variant="primary" size="md" className="h-12 w-full rounded-xl"><Link href="/app" onClick={onClose}><CompassIcon aria-hidden />Explore live auctions</Link></Button>
          <Button asChild variant="secondary" size="md" className="h-12 w-full rounded-xl"><Link href="/app/portfolio" onClick={onClose}>Back to portfolio</Link></Button>
        </>
      }
    >
      <p className="inline max-w-[420px] text-[14px] text-text-2">
        Your {units} {units === "1.0" ? "shard" : "shards"} of {cardName} {units === "1.0" ? "was" : "were"} bought out
        {info.redeemer && <> by <AddressName address={info.redeemer} avatar={false} copyable={false} className="inline-flex align-baseline [&>span]:font-sans [&>span]:text-[14px] [&>span]:text-text-2" /></>}
        {" "}at {money(info.buyoutPerShard, 0)} per shard. The USDC is in your wallet.
      </p>
      <TxChip label="tx" hash={info.hash} />
    </Shell>
  );
}

/** After a buyout: the card is whole and yours, what went to the other holders, and the pickup. */
export function RedeemedView({ info, cardName, onClose }: { info: RedeemedInfo; cardName: string; onClose: () => void }) {
  const paid = info.payoutUsdc + info.feeUsdc;
  const feePct = info.payoutUsdc > 0n ? Number((info.feeUsdc * 10_000n) / info.payoutUsdc) / 100 : null;
  return (
    <Shell
      icon={<KeyRoundIcon aria-hidden strokeWidth={1.75} />}
      amount={paid > 0n ? `-${money(paid)}` : "100%"}
      title={`${cardName} is yours`}
      actions={
        <>
          <Button variant="redeem" size="md" className="h-12 w-full rounded-xl" onClick={onClose}><ArrowRightIcon aria-hidden />See {cardName}</Button>
          <Button asChild variant="secondary" size="md" className="h-12 w-full rounded-xl"><Link href="/app/portfolio" onClick={onClose}>Back to portfolio</Link></Button>
        </>
      }
    >
      <p className="max-w-[420px] text-[14px] text-text-2">
        {paid > 0n
          ? `You bought out the other ${shardsFixed(info.missing)} shards at ${money(info.buyoutPerShard, 0)} per shard. The other holders claim their USDC any time. Pick up the card at the vault with a Passport check.`
          : "You held every shard, so nothing was paid. The card is whole again under your name. Pick it up at the vault with a Passport check."}
      </p>
      <TxChip label="redeem" hash={info.hash} />
      {paid > 0n && (
        <div className="w-full rounded-2xl border border-border bg-surface text-left text-[14px]">
          <div className="flex justify-between border-b border-border px-4 py-3"><span className="text-text-2">Paid to holders</span><span className="font-mono text-text">{money(info.payoutUsdc)}</span></div>
          <div className="flex justify-between border-b border-border px-4 py-3"><span className="text-text-2">Vault fee{feePct != null ? ` ${feePct}%` : ""}</span><span className="font-mono text-text">{money(info.feeUsdc)}</span></div>
          <div className="flex justify-between px-4 py-3"><span className="font-semibold text-text">You paid</span><span className="font-mono text-kin">{money(paid)}</span></div>
        </div>
      )}
    </Shell>
  );
}
