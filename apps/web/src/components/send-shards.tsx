"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangleIcon, CheckCheckIcon, ExternalLinkIcon, SendIcon } from "lucide-react";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { abi } from "@kura/shared";
import { AmountInput, Button, notify } from "@/components/kura";
import { TxStepper } from "@/components/tx-stepper";
import { useVaultIo } from "@/components/vault-io";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useKuraUser } from "@/hooks/use-kura-user";
import { dropsBelowThreshold } from "@/lib/buyout";
import { shareOf } from "@/lib/card-view";
import { explorerTx } from "@/lib/chain";
import { shardsFixed, shortAddress, shortHash } from "@/lib/format";
import type { ResolvedOwner } from "@/lib/owner";
import type { Step } from "@/lib/tx";
import { cn } from "@/lib/utils";

/** "1.0" → shard units; null for anything that isn't a positive amount with at most 18 decimals. */
export function parseShardAmount(s: string): bigint | null {
  const v = s.trim();
  if (!/^\d*\.?\d{0,18}$/.test(v) || v === "" || v === ".") return null;
  try {
    const units = parseUnits(v, 18);
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}

const label = (units: bigint) => `${shardsFixed(units)} ${units === 10n ** 18n ? "shard" : "shards"}`;

/** Resolves typed handle input, debounced; null while empty or typing. */
function useResolved(input: string, resolve: (s: string) => Promise<ResolvedOwner | null>) {
  const [out, setOut] = useState<{ input: string; r: ResolvedOwner | null } | null>(null);
  useEffect(() => {
    if (!input.trim()) return;
    let live = true;
    const t = setTimeout(() => void resolve(input).then((r) => { if (live) setOut({ input, r }); }), 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [input, resolve]);
  return input.trim() && out?.input === input ? out.r : null;
}

/**
 * lkEjP: send shards wallet-to-wallet to a Kura handle (a plain ERC-20 transfer). Warns when the transfer takes the
 * sender below the 80% needed to redeem, and ends on a sent confirmation.
 */
export function SendShardsSheet({ open, onOpenChange, cardName, shardToken, balance, supply, initialTo = "" }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cardName: string;
  shardToken: Address;
  /** Live balanceOf(me) and totalSupply() of the shard token. */
  balance: bigint;
  supply: bigint;
  /** Prefilled recipient (previews). */
  initialTo?: string;
}) {
  const io = useVaultIo();
  const { address: me } = useKuraUser();
  const [to, setTo] = useState(initialTo);
  const [amount, setAmount] = useState("1.0");
  const [sent, setSent] = useState<{ hash: Hex; units: bigint; name: string } | null>(null);
  const resolved = useResolved(to, io.resolveHandle);
  const startBalance = useRef<bigint | null>(null);
  const hash = useRef<Hex | null>(null);

  const units = parseShardAmount(amount);
  const self = resolved?.ok && me && resolved.address.toLowerCase() === me.toLowerCase();
  const recipient = resolved?.ok && !self ? resolved : null;
  const amountError = amount.trim() === "" ? null : units == null ? "Enter an amount of shards" : units > balance ? `You have ${shardsFixed(balance)}` : null;
  const ok = !!recipient && units != null && units <= balance;
  const warn = units != null && units <= balance && dropsBelowThreshold(balance, supply, units);
  const after = units != null && units <= balance ? balance - units : balance;

  function close(open: boolean) {
    onOpenChange(open);
    if (!open) {
      setSent(null);
      setTo("");
      setAmount("1.0");
    }
  }

  const steps: Step[] = [{
    id: "send",
    label: units != null ? `Send ${label(units)}` : "Send shards",
    // A retry after the transfer landed must not send it again: the balance has then dropped by the amount.
    skip: async () => {
      const now = await io.read<bigint>({ address: shardToken, abi: abi.shardToken, functionName: "balanceOf", args: [me!] });
      if (startBalance.current == null) {
        startBalance.current = now;
        return false;
      }
      return now + (units ?? 0n) <= startBalance.current;
    },
    run: async () => {
      const r = await io.send({ to: shardToken, abi: abi.shardToken, functionName: "transfer", args: [recipient!.address, units!] });
      hash.current = r.hash;
      return r;
    },
  }];

  const chips: [string, string][] = [["0.5", "0.5"], ["1", "1.0"], ["Max", formatUnits(balance, 18)]];

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="bottom" className="mx-auto max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border-border bg-surface px-5 pt-3 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
        <span aria-hidden className="mx-auto h-1 w-9 rounded-full bg-border" />
        {sent ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center" aria-live="polite">
            <span className="flex size-20 items-center justify-center rounded-full border-2 border-good bg-good-soft text-good-fg"><CheckCheckIcon aria-hidden className="size-9" /></span>
            <SheetTitle className="font-display text-[24px] font-semibold text-text">Sent {label(sent.units)}</SheetTitle>
            <SheetDescription className="text-[14px] text-text-2">{label(sent.units)} of {cardName} went to {sent.name}. They show up in their portfolio right away.</SheetDescription>
            <a href={explorerTx(sent.hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text-2 hover:text-text">
              tx {shortHash(sent.hash)}<ExternalLinkIcon aria-hidden className="size-3" />
            </a>
            <Button variant="secondary" size="md" className="mt-2 h-12 w-full rounded-xl" onClick={() => close(false)}>Done</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-5 pt-3">
            <SheetTitle className="font-display text-[24px] leading-tight font-semibold text-text">Send {cardName} shards</SheetTitle>
            <SheetDescription className="sr-only">Send shards to a Kura handle</SheetDescription>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="send-to" className="text-[12px] text-text-2">To</label>
              <div className={cn("flex items-center gap-3 rounded-xl border bg-bg px-3.5 py-3 transition-colors", recipient ? "border-good" : resolved && !resolved.ok ? "border-shu" : "border-border focus-within:border-shu")}>
                <span aria-hidden className={cn("size-6 shrink-0 rounded-full", recipient ? "bg-[linear-gradient(-135deg,var(--kura-s7)_15%,var(--kura-s2)_85%)]" : "bg-surface-2")} />
                <input
                  id="send-to"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="kenji.kura.eth"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="w-full min-w-0 bg-transparent font-mono text-[16px] text-text outline-none placeholder:text-muted-foreground"
                />
                {recipient && <span className="shrink-0 font-mono text-[12px] text-text-2">{shortAddress(recipient.address)}</span>}
              </div>
              {resolved && !resolved.ok && <p className="text-[12px] text-shu">{resolved.error}</p>}
              {self && <p className="text-[12px] text-shu">That&apos;s your own handle</p>}
            </div>
            <AmountInput
              label={<span className="flex w-full justify-between"><span>Shards</span><span>You have {shardsFixed(balance)}</span></span>}
              unit={null}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              tone={amountError ? "shu" : "default"}
              hint={amountError ?? undefined}
              hintClassName={amountError ? "text-shu" : undefined}
              trailing={
                <span className="flex gap-1.5">
                  {chips.map(([k, v]) => (
                    <button key={k} type="button" onClick={() => setAmount(v)} className="rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-2 hover:text-text">{k}</button>
                  ))}
                </span>
              }
            />
            {warn && (
              <div role="status" className="flex items-start gap-3 rounded-xl border border-shu/30 bg-shu-soft p-3.5 text-[13px] text-text-2">
                <AlertTriangleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-shu" />
                <span>After sending you&apos;ll hold {shardsFixed(after)} ({Math.round(shareOf(after, supply) * 1000) / 10}%), below the 80% needed to redeem.</span>
              </div>
            )}
            <p className="text-[12px] text-muted-foreground">Wallet-to-wallet transfers are free. The vault fee only applies to auctions and buyouts.</p>
            <TxStepper
              steps={steps}
              cta={units != null ? `Send ${label(units)}` : "Send shards"}
              ctaIcon={<SendIcon aria-hidden />}
              ctaClassName="h-12 rounded-xl text-[15px]"
              disabled={!ok}
              title="Sending shards"
              failedTitle="The transfer didn't go through"
              successToast={false}
              walletKind={io.walletKind}
              onCancel={() => { startBalance.current = null; }}
              onDone={() => {
                const h = hash.current;
                startBalance.current = null;
                hash.current = null;
                if (units != null && recipient && h) {
                  setSent({ hash: h, units, name: recipient.name });
                  notify({ title: "Shards sent", body: `${label(units)} to ${recipient.name}`, tone: "good", icon: <CheckCheckIcon /> });
                } else close(false);
              }}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
