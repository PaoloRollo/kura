"use client";

import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { HandCoinsIcon } from "lucide-react";
import type { Address, TransactionReceipt } from "viem";
import { abi } from "@kura/shared";
import { AddressName } from "@/components/address-name";
import { Panel } from "@/components/card-state-panel";
import { notify } from "@/components/kura";
import { TxStepper } from "@/components/tx-stepper";
import { useVaultIo } from "@/components/vault-io";
import { claimedFromReceipt, showVaultSuccess, type ClaimedInfo } from "@/components/vault-success";
import { payoutFor } from "@/lib/buyout";
import { addresses } from "@/lib/chain";
import { money, shardsFixed } from "@/lib/format";
import type { Revert, Step, StepResult } from "@/lib/tx";
import { cn } from "@/lib/utils";

export type PayoutSharding = { cardId: bigint; shardToken: Address; buyoutPerShard: bigint; redeemer: Address | null };

/** My live balance of a bought-out sharding's token: what claimPayout burns. */
export function usePayoutBalance(shardToken: Address, me: Address | null) {
  const io = useVaultIo();
  return useQuery({
    queryKey: ["payout-balance", shardToken, me?.toLowerCase() ?? null],
    queryFn: () => io.read<bigint>({ address: shardToken, abi: abi.shardToken, functionName: "balanceOf", args: [me!] }),
    enabled: !!me,
    refetchInterval: 12_000,
  });
}

function describePayoutError(_e: unknown, r: Revert) {
  const name = r.inner?.name ?? r.name;
  if (name === "NotRedeemed") return { title: "This card wasn't bought out", body: "There is no payout to claim for these shards." };
  if (name === "NothingToClaim") return { title: "Nothing left to claim", body: "These shards were already paid out." };
  return r.hash ? { title: "The transaction reverted", body: "Nothing was paid. You can try again." } : { title: "Something went wrong", body: r.message };
}

/**
 * A minority payout after a buyout: burn my shards of that sharding for USDC at the buyout price (claimPayout).
 * `card`: a panel on the card page; `banner`: the kin portfolio banner (QEEV7/YH4Ft). Success shows UwCiy through
 * `showVaultSuccess`, or `onClaimed` when given.
 */
export function PayoutPanel({ sharding, me, cardName, layout = "card", onClaimed, className }: {
  sharding: PayoutSharding;
  me: Address | null;
  cardName: string;
  layout?: "card" | "banner";
  onClaimed?: (info: ClaimedInfo) => void;
  className?: string;
}) {
  const io = useVaultIo();
  const bal = usePayoutBalance(sharding.shardToken, me);
  const receipt = useRef<TransactionReceipt | null>(null);
  const balance = bal.data ?? 0n;
  if (!me || balance === 0n) return null;
  const amount = payoutFor(sharding.buyoutPerShard, balance);
  const units = shardsFixed(balance);
  const noun = units === "1.0" ? "shard" : "shards";

  const steps: Step[] = [{
    id: "claim",
    label: `Burn ${units} ${noun} and receive ${money(amount)}`,
    skip: async () => (await io.read<bigint>({ address: sharding.shardToken, abi: abi.shardToken, functionName: "balanceOf", args: [me] })) === 0n,
    run: async () => {
      const sent = await io.send({ to: addresses.cardVault, abi: abi.cardVault, functionName: "claimPayout", args: [sharding.shardToken] });
      receipt.current = sent.receipt;
      return sent;
    },
  }];
  function onDone(results: StepResult[]) {
    const r = receipt.current;
    receipt.current = null;
    const parsed = r ? claimedFromReceipt({ buyoutPerShard: sharding.buyoutPerShard, redeemer: sharding.redeemer }, r) : null;
    // No PayoutClaimed to read (unparsable receipt, or a claim that had already landed): confirm with what was due.
    const info: ClaimedInfo = parsed ?? {
      kind: "claimed", cardId: sharding.cardId, hash: r?.transactionHash ?? results.find((x) => x.id === "claim")?.hash,
      shardUnits: balance, usdc: amount, buyoutPerShard: sharding.buyoutPerShard, redeemer: sharding.redeemer,
    };
    notify({ title: "Payout claimed", body: `${money(info.usdc)} for your ${shardsFixed(info.shardUnits)} ${noun} of ${cardName}`, tone: "good", icon: <HandCoinsIcon /> });
    if (onClaimed) onClaimed(info);
    else showVaultSuccess(info);
  }
  const stepper = (
    <TxStepper
      steps={steps}
      cta={`Claim ${money(amount)}`}
      ctaIcon={<HandCoinsIcon aria-hidden />}
      ctaClassName={cn("rounded-xl bg-kin text-kin-ink hover:bg-kin/90", layout === "banner" ? "h-11" : "h-12 text-[15px]")}
      title="Claiming your payout"
      failedTitle="The claim didn't go through"
      describeError={describePayoutError}
      retryable={(r) => !["NotRedeemed", "NothingToClaim"].includes(r.inner?.name ?? r.name ?? "")}
      successToast={false}
      walletKind={io.walletKind}
      onDone={onDone}
    />
  );
  const by = sharding.redeemer ? <AddressName address={sharding.redeemer} avatar={false} copyable={false} className="inline-flex align-baseline [&>span]:font-sans [&>span]:text-[inherit] [&>span]:text-inherit" /> : "another holder";

  if (layout === "banner") {
    return (
      <section className={cn("flex flex-col gap-4 rounded-2xl border border-kin/40 bg-kin-soft p-5 sm:flex-row sm:items-center", className)}>
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-kin/20 text-kin"><HandCoinsIcon aria-hidden className="size-5" /></span>
        <p className="min-w-0 flex-1 text-[14px] text-text">
          {cardName} was bought out by {by} · Claim {money(amount)} for your {units} {noun}
        </p>
        <div className="sm:w-56">{stepper}</div>
      </section>
    );
  }
  return (
    <Panel className={cn("flex flex-col gap-5 border-kin/40 p-6 md:p-7", className)}>
      <div className="flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-kin-soft text-kin"><HandCoinsIcon aria-hidden className="size-6" /></span>
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-[24px] leading-tight font-semibold text-text">This card was bought out</h2>
          <p className="text-[14px] text-text-2">
            {by} bought out {cardName} at {money(sharding.buyoutPerShard, 0)} per shard. Your {units} {noun} {noun === "shard" ? "is" : "are"} worth <span className="font-mono text-text">{money(amount)}</span>: claim it any time.
          </p>
        </div>
      </div>
      <div className="md:max-w-sm">{stepper}</div>
    </Panel>
  );
}
