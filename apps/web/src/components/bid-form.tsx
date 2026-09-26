"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CircleCheckIcon, ExternalLinkIcon, GlobeIcon, LockIcon, RepeatIcon, ScanFaceIcon, UserXIcon } from "lucide-react";
import { maxUint256, type Address, type Hex } from "viem";
import { abi, q96ToUsdcPerShard } from "@kura/shared";
import { AmountInput, Button, notify } from "@/components/kura";
import { useAuctionIo, type AuctionChain } from "@/components/auction-io";
import { TxStepper, describeTxError } from "@/components/tx-stepper";
import { WorldIdGate, worldIdErrorMessage, type IssuedTicket } from "@/components/world-id-gate";
import type { ShardingRow } from "@/hooks/use-card";
import { useTicket } from "@/hooks/use-ticket";
import { TICKET_ERRORS, bidRevertMessage, defaultMaxPriceQ96, endedNowPreview, isRetryableBidError, isValidMax, maxQ96FromUsdc } from "@/lib/bid-math";
import { addresses, explorerTx } from "@/lib/chain";
import { money, shortAddress, shortHash, shardsFixed } from "@/lib/format";
import { TxError, encodeHookData, type Revert, type Sent } from "@/lib/tx-core";
import { cn } from "@/lib/utils";

/** "2,000.00" → 2_000_000_000n; null for anything that isn't a USDC amount. */
export function parseUsdcText(text: string): bigint | null {
  const t = text.replace(/[,\s]/g, "");
  if (!/^\d*\.?\d{0,6}$/.test(t) || t === "" || t === ".") return null;
  const [i = "0", f = ""] = t.split(".");
  return BigInt(i || "0") * 1_000_000n + BigInt(f.padEnd(6, "0") || "0");
}

/** USDC for an input field: "1,760.00". */
const fieldText = (x: bigint) => money(x).slice(1);

const nowSec = () => Math.floor(Date.now() / 1000);

const PERMIT2_TTL_SEC = 86_400;
/** A Permit2 allowance that expires sooner than this is renewed, so it can't lapse before the bid mines. */
const PERMIT2_MARGIN_SEC = 600;

type Placed = { hash: Hex | undefined; budgetUsdc: bigint; maxUsdc: bigint };

/**
 * The bid form (HisVE, aD9is, p5hrR): World ID, "Spend up to", "Highest price you'd pay per shard", the "If the
 * auction ended now" box and the three-step Place bid (USDC → Permit2, Permit2 → auction, submitBid with the ticket).
 */
export function BidForm({ sharding, me, chain, clearingQ96, className }: {
  sharding: ShardingRow;
  me: Address | null;
  chain: AuctionChain;
  /** The live clearing price (chain first, else the indexer's latest checkpoint). */
  clearingQ96: bigint;
  className?: string;
}) {
  const io = useAuctionIo();
  const cached = useTicket("bid", me);
  const issued = io.ticket !== undefined ? io.ticket : cached.issued;
  // The bid step reads the ticket at send time: a "Verify and retry" swaps it after the steps were built.
  const ticketRef = useRef<IssuedTicket | null>(issued);
  useEffect(() => {
    ticketRef.current = issued;
  }, [issued]);
  const auction = sharding.auction as Address;
  const tick = sharding.tickSpacingQ96;

  const [budget, setBudget] = useState(io.formDefaults?.budget ?? "");
  const [max, setMax] = useState<string | null>(io.formDefaults?.max ?? null);
  const [refused, setRefused] = useState<{ boundTo: string | null } | null>(null);
  const [needTicket, setNeedTicket] = useState(false);
  // "Verify and retry" remounts the gate with autoStart, which opens IDKit straight away.
  const [reverifying, setReverifying] = useState(0);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const reverify = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);

  // The max follows the clearing price (+2 ticks) until the user types one.
  const defaultMax = defaultMaxPriceQ96(clearingQ96, tick);
  const maxText = max ?? fieldText(q96ToUsdcPerShard(defaultMax));

  const budgetUsdc = parseUsdcText(budget) ?? 0n;
  const maxUsdcTyped = parseUsdcText(maxText);
  const maxQ96 = maxUsdcTyped != null ? maxQ96FromUsdc(maxUsdcTyped, tick) : 0n;
  const maxUsdc = q96ToUsdcPerShard(maxQ96);
  const validMax = isValidMax(maxQ96, clearingQ96, tick);
  const overBalance = chain.balance != null && budgetUsdc > chain.balance;
  const budgetOk = budgetUsdc > 0n && !overBalance;
  const preview = endedNowPreview({ budgetUsdc, maxQ96, clearingQ96, forSale: sharding.forSale });
  const clearingUsdc = q96ToUsdcPerShard(clearingQ96);

  const onTicket = (t: IssuedTicket) => {
    setRefused(null);
    setNeedTicket(false);
    ticketRef.current = t;
    cached.save(t);
    reverify.current?.resolve();
    reverify.current = null;
  };
  const onGateError = (code: string, details?: Record<string, unknown>) => {
    if (code === "ALREADY_BOUND") setRefused({ boundTo: typeof details?.boundTo === "string" ? details.boundTo : null });
    else notify({ title: "World ID", body: worldIdErrorMessage(code), tone: "shu" });
    reverify.current?.reject(new Error(code === "ALREADY_BOUND" ? "This World ID already bids from another wallet." : worldIdErrorMessage(code)));
    reverify.current = null;
  };

  const onGateClose = () => {
    reverify.current?.reject(new Error("Verification was closed. Verify and retry when you're ready."));
    reverify.current = null;
  };

  const errName = (r: Revert) => r.inner?.name ?? r.name;
  const onBidError = (r: Revert) => {
    const name = errName(r);
    if (name && TICKET_ERRORS.has(name)) {
      cached.clear();
      ticketRef.current = null;
      setNeedTicket(true);
    } else if (name === "AlreadyBound") {
      setRefused({ boundTo: typeof r.inner?.args[0] === "string" ? r.inner.args[0] : null });
    } else if (name === "BidMustBeAboveClearingPrice") {
      setMax(null); // back to clearing + 2 ticks, from the refreshed clearing price
      void chain.refetch();
    }
  };

  const steps = me
    ? [
        {
          id: "approve-usdc",
          label: "Approve USDC for Permit2 (once)",
          skip: async () => (await io.read<bigint>({ address: addresses.usdc, abi: abi.erc20, functionName: "allowance", args: [me, addresses.permit2] })) >= budgetUsdc,
          run: () => io.send({ to: addresses.usdc, abi: abi.erc20, functionName: "approve", args: [addresses.permit2, maxUint256] }),
        },
        {
          id: "permit2",
          label: "Allow this auction to pull your budget",
          skip: async () => {
            const [amount, expiration] = await io.read<readonly [bigint, number, number]>({ address: addresses.permit2, abi: abi.permit2, functionName: "allowance", args: [me, addresses.usdc, auction] });
            return amount >= budgetUsdc && Number(expiration) > nowSec() + PERMIT2_MARGIN_SEC;
          },
          run: () => io.send({ to: addresses.permit2, abi: abi.permit2, functionName: "approve", args: [addresses.usdc, auction, budgetUsdc, nowSec() + PERMIT2_TTL_SEC] }),
        },
        {
          id: "bid",
          label: `Bid ${money(budgetUsdc)} at up to ${money(maxUsdc)} per shard`,
          run: async (): Promise<Sent> => {
            const t = ticketRef.current;
            if (!t) throw new TxError("Verify with World ID first.");
            const hookData = encodeHookData({ kind: t.ticket.kind, subject: t.ticket.subject, nullifier: BigInt(t.ticket.nullifier), expiresAt: BigInt(t.ticket.expiresAt) }, t.signature);
            return io.send({ to: auction, abi: abi.ccaAuction, functionName: "submitBid", args: [maxQ96, budgetUsdc, me, hookData], value: 0n });
          },
        },
      ]
    : [];

  if (placed) {
    return (
      <div className={cn("flex flex-col gap-4", className)} aria-live="polite">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-good-soft text-good-fg"><CheckIcon aria-hidden className="size-5" strokeWidth={2.5} /></span>
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="font-display text-[22px] leading-tight font-semibold text-text">Bid placed</h3>
            <p className="text-[13px] text-text-2">
              {money(placed.budgetUsdc)} at up to {money(placed.maxUsdc)} per shard. You stay in while the clearing price is below your max; whatever isn&apos;t used is refunded when you exit.
            </p>
          </div>
        </div>
        {placed.hash && (
          <a href={explorerTx(placed.hash)} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text-2 hover:text-text">
            bid {shortHash(placed.hash)}<ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        )}
        <Button variant="secondary" size="md" onClick={() => { setPlaced(null); setBudget(""); setMax(null); }}>Place another bid</Button>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {refused ? (
        <div role="alert" className="flex flex-col gap-4 rounded-2xl border border-shu/40 bg-shu-soft/40 p-4">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-shu-soft text-shu"><UserXIcon aria-hidden className="size-5" /></span>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-[15px] font-semibold text-text">This World ID already bids from another wallet</h3>
              <p className="text-[13px] text-text-2">
                One human, one bidding wallet.{refused.boundTo ? <> You first bid from <span className="font-mono">{shortAddress(refused.boundTo)}</span>.</> : null} Log in with that wallet to bid here.
              </p>
            </div>
          </div>
          <Button variant="secondary" size="md" className="h-11 rounded-xl" onClick={io.switchWallet}><RepeatIcon aria-hidden />Switch wallet</Button>
        </div>
      ) : issued ? (
        <p className="flex items-center gap-2 rounded-lg bg-good-soft px-3.5 py-2.5 text-[12px] text-good-fg">
          <CircleCheckIcon aria-hidden className="size-4 shrink-0" />World ID verified · one human, one wallet
        </p>
      ) : (
        <div className="flex flex-col gap-4 rounded-2xl border border-border bg-bg/60 p-4">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text"><ScanFaceIcon aria-hidden className="size-5" /></span>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-[15px] font-semibold text-text">Prove you&apos;re a unique human</h3>
              <p className="text-[13px] text-text-2">One World ID can bid from one wallet only. Nothing about you is shared.</p>
            </div>
          </div>
          {io.Gate ? (
            <io.Gate onTicket={onTicket} onError={onGateError} autoStart={reverifying > 0} />
          ) : me ? (
            <WorldIdGate
              key={reverifying}
              action="bid"
              signal={me}
              onTicket={onTicket}
              onError={onGateError}
              onClose={onGateClose}
              autoStart={reverifying > 0}
              variant="inverse"
              icon={<GlobeIcon aria-hidden />}
              className="h-11 w-full rounded-xl text-[15px]"
            />
          ) : null}
        </div>
      )}

      <AmountInput
        label="Spend up to"
        placeholder="500.00"
        value={budget}
        onChange={(e) => setBudget(e.target.value)}
        tone={budget && !budgetOk ? "shu" : "default"}
        hint={
          overBalance ? <>You have {money(chain.balance ?? 0n)} USDC. Get Sepolia USDC from faucet.circle.com.</>
          : budget && budgetUsdc === 0n ? "Enter an amount above zero."
          : "The total you commit. Whatever isn't used is refunded."
        }
        hintClassName={budget && !budgetOk ? "text-shu" : undefined}
      />
      <AmountInput
        label="Highest price you'd pay per shard"
        value={maxText}
        onChange={(e) => setMax(e.target.value)}
        tone={!validMax ? "shu" : "default"}
        hint={
          !validMax
            ? <>Use a step of {money(q96ToUsdcPerShard(tick))}, at least one step above the current {money(clearingUsdc)}.</>
            : <>You stay in while the price is below this. Current {money(clearingUsdc, 0)}, steps of {money(q96ToUsdcPerShard(tick), 0)}.</>
        }
        hintClassName={!validMax ? "text-shu" : undefined}
      />

      {budgetUsdc > 0n && <div className="flex flex-col gap-2 rounded-xl border border-border bg-bg/60 p-3.5 text-[12px]">
        <div className="text-[12px] font-semibold text-text">If the auction ended now</div>
        <PreviewRow label="Everyone pays" value={`${money(preview.clearingUsdc)} / shard`} />
        <PreviewRow label="You get" value={`${shardsFixed(preview.shards, 3)} shards`} />
        <PreviewRow label="Refunded" value={money(preview.refundedUsdc)} />
        <PreviewRow label="Out if price passes" value={money(preview.outAtUsdc)} tone="shu" />
      </div>}

      {(issued || needTicket) && !refused && me ? (
        <TxStepper
          cta="Place bid"
          ctaClassName="h-12 rounded-xl text-[15px]"
          title="Placing your bid"
          failedTitle="Your bid didn't go through"
          disabled={!issued || !budgetOk || !validMax}
          steps={steps}
          walletKind={io.walletKind}
          successToast={false}
          describeError={(e, r) => bidRevertMessage(errName(r)) ?? describeTxError(e, r)}
          retryable={(r) => isRetryableBidError(errName(r))}
          backLabel="Edit bid"
          retryLabel={needTicket ? "Verify and retry" : "Retry"}
          onRetry={needTicket ? () => (ticketRef.current ? undefined : new Promise<void>((resolve, reject) => { reverify.current = { resolve, reject }; setReverifying((k) => k + 1); })) : undefined}
          onError={(_, r) => onBidError(r)}
          onDone={(results) => {
            const hash = results.find((r) => r.id === "bid")?.hash;
            setPlaced({ hash, budgetUsdc, maxUsdc });
            notify({ title: "Bid placed", body: `${money(budgetUsdc)} at up to ${money(maxUsdc)} per shard`, tone: "good", icon: <CheckIcon /> });
          }}
        />
      ) : (
        <Button variant="disabled" size="md" className="h-12 w-full rounded-xl text-[15px]" disabled>
          <LockIcon aria-hidden />{refused ? "Switch wallet to place a bid" : "Verify to place a bid"}
        </Button>
      )}
      <p className="text-[12px] text-muted-foreground">
        3 steps: approve USDC, allow auction, bid.{io.walletKind === "embedded" ? " Gas is on us." : ""}
      </p>
    </div>
  );
}

function PreviewRow({ label, value, tone }: { label: string; value: string; tone?: "shu" }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-2">{label}</span>
      <span className={cn("font-mono text-[13px]", tone === "shu" ? "text-shu" : "text-text")}>{value}</span>
    </div>
  );
}
