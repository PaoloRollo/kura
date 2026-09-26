"use client";

import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRightIcon, BotIcon, CheckIcon, CloudOffIcon, KeyRoundIcon, PackageOpenIcon, SendIcon } from "lucide-react";
import { parseUnits, type Address, type Hex, type TransactionReceipt } from "viem";
import { abi } from "@kura/shared";
import { Button, RedemptionMeter } from "@/components/kura";
import { Panel } from "@/components/card-state-panel";
import { prefillMarket, useMarketIo } from "@/components/market-panel";
import { SendShardsSheet } from "@/components/send-shards";
import { TxStepper } from "@/components/tx-stepper";
import { AppraiseError, useVaultIo, type VaultIo } from "@/components/vault-io";
import { redeemedFromReceipt, showVaultSuccess, type RedeemedInfo } from "@/components/vault-success";
import { Skeleton } from "@/components/ui/skeleton";
import type { CardData } from "@/hooks/use-card";
import { useNow } from "@/hooks/use-now";
import { useHandles } from "@/hooks/use-handles";
import { displayName } from "@/lib/handles";
import type { AppraiseResult } from "@/lib/appraise";
import { REFRESH_BEFORE_SEC, canAttemptAppraisal, throttledAppraisal } from "@/lib/appraisal-refresh";
import { buyoutQuote, payoutFor, shardsShort, type BuyoutQuote } from "@/lib/buyout";
import { addresses } from "@/lib/chain";
import { holdersView, shareOf } from "@/lib/card-view";
import { money, shardsFixed } from "@/lib/format";
import { isTradable, poolKeyOf, quoteBuyExactShards, shortfallBudget } from "@/lib/market";
import { formatUsdcInput } from "@/lib/shard-math";
import { metaCardName } from "@/lib/meta";
import { TxError, type Revert, type Step, type StepResult } from "@/lib/tx";
import { cn } from "@/lib/utils";

const SHARDED = 3; // CardVault.State.Sharded

type Chain = { supply: bigint; balance: bigint; usdc: bigint; allowance: bigint; feeBps: bigint; clearingQ96: bigint };

/** What `redeem` reads at tx time (W7): totalSupply, balanceOf(me), the settle price and the fee; plus my USDC. */
async function readChain(io: VaultIo, token: Address, me: Address): Promise<Chain> {
  const [supply, balance, usdcBal, allowance, feeBps, s] = await Promise.all([
    io.read<bigint>({ address: token, abi: abi.shardToken, functionName: "totalSupply" }),
    io.read<bigint>({ address: token, abi: abi.shardToken, functionName: "balanceOf", args: [me] }),
    io.read<bigint>({ address: addresses.usdc, abi: abi.erc20, functionName: "balanceOf", args: [me] }),
    io.read<bigint>({ address: addresses.usdc, abi: abi.erc20, functionName: "allowance", args: [me, addresses.cardVault] }),
    io.read<number | bigint>({ address: addresses.cardVault, abi: abi.cardVault, functionName: "feeBps" }),
    io.read<{ clearingPriceQ96: bigint }>({ address: addresses.cardVault, abi: abi.cardVault, functionName: "shardings", args: [token] }),
  ]);
  return { supply, balance, usdc: usdcBal, allowance, feeBps: BigInt(feeBps), clearingQ96: s.clearingPriceQ96 };
}

/** The live redeem state of the card's current sharding for `me`: chain reads each block, and a fresh appraisal. */
export function useRedeem(c: CardData, me: Address | null) {
  const io = useVaultIo();
  const token = c.sharding?.shardToken ?? null;
  const cardId = c.card?.id ?? 0n;
  const chain = useQuery({
    queryKey: ["redeem-chain", token, me?.toLowerCase() ?? null],
    queryFn: () => readChain(io, token!, me!),
    enabled: !!token && !!me,
    refetchInterval: 12_000,
  });
  const ch = chain.data ?? null;
  const eligible = !!ch && ch.supply > 0n && ch.balance * 5n >= ch.supply * 4n;
  const full = !!ch && ch.supply > 0n && ch.balance >= ch.supply;
  const queryClient = useQueryClient();
  const appraisalKey = ["appraisal", cardId.toString(), token];
  const appraisal = useQuery<AppraiseResult, Error>({
    queryKey: appraisalKey,
    queryFn: () =>
      throttledAppraisal(
        () => io.appraise(cardId),
        () => {
          const cached = queryClient.getQueryData<AppraiseResult>(appraisalKey);
          const left = cached ? Number(cached.appraisal.expiresAt) - Math.floor(Date.now() / 1000) : 0;
          return cached && left >= REFRESH_BEFORE_SEC ? cached : undefined;
        },
      ),
    enabled: eligible && !full,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const now = useNow(1000);
  const expiresAt = appraisal.data ? Number(appraisal.data.appraisal.expiresAt) : null;
  const left = expiresAt != null ? expiresAt - now : null;
  const { refetch, isFetching, isError } = appraisal;
  // Quote expired or about to: fetch a new one without asking (the design shows the quote as always ready). After a
  // failure only once the backoff allows it; never more than once per 10 s per tab (lib/appraisal-refresh).
  const due = isError || (left != null && left < REFRESH_BEFORE_SEC);
  useEffect(() => {
    if (due && !isFetching && canAttemptAppraisal(now * 1000)) void refetch();
  }, [due, now, isFetching, refetch]);
  // A signature with no time left can't be sent: the CTA waits for the fresh one.
  const quoteReady = !!appraisal.data && left != null && left > 0;

  const quote: BuyoutQuote | null = ch
    ? buyoutQuote({ supply: ch.supply, balance: ch.balance, clearingQ96: ch.clearingQ96, appraisedUsdcPerShard: BigInt(appraisal.data?.appraisal.usdcPerShard ?? "0"), feeBps: ch.feeBps })
    : null;
  return { io, chain: ch, chainLoading: chain.isLoading, eligible, full, appraisal, now, left: left != null ? Math.max(0, left) : null, quoteReady, quote };
}

type RedeemState = ReturnType<typeof useRedeem>;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** The other holders a buyout pays: every live holder but me, the auction(s) and the vault. */
function usePaidTo(c: CardData, me: Address | null) {
  const handles = useHandles();
  const view = holdersView({ balances: c.holders, sharding: c.sharding, shardings: c.allShardings, transfers: c.transfers, vault: addresses.cardVault });
  const others = view.rows.filter((r) => r.holder.toLowerCase() !== me?.toLowerCase());
  const parent = `.${addresses.ensParentLabel}.eth`;
  const names = others.map((r) => displayName(r.holder, handles, addresses).replace(parent, ""));
  return { names, count: others.length + (view.unclaimed > 0n ? 1 : 0), unclaimed: view.unclaimed };
}

function redeemRevert(r: Revert, supply: bigint, balance: bigint): { title: string; body?: string } | null {
  switch (r.inner?.name ?? r.name) {
    case "BelowThreshold": {
      const [bal, sup] = (r.args as [bigint, bigint] | undefined) ?? [balance, supply];
      return { title: `You need 80%: ${shardsFixed(shardsShort(bal ?? balance, sup ?? supply))} shards short`, body: "Your share changed since the quote. Nothing was charged." };
    }
    case "Expired": return { title: "The appraisal expired", body: "Retry fetches a fresh one and sends again." };
    case "AppraisalMismatch": return { title: "The appraisal is for another sharding", body: "Retry fetches a fresh one for this card." };
    case "BadSignature": return { title: "The appraisal signature was refused", body: "Retry fetches a freshly signed one." };
    case "WrongState": return { title: "This card can't be redeemed now", body: "It was already bought out or is no longer sharded." };
    case "ERC20InsufficientAllowance": return { title: "The USDC approval is too small", body: "The price moved. Retry approves the new amount." };
    case "ERC20InsufficientBalance": return { title: "Not enough USDC", body: "Top up your wallet and try again." };
    default: return null;
  }
}

/** A landed buyout read back from the vault: its buyout price, and the payout and fee it implies for `missing`. */
async function redeemedFromChain(io: VaultIo, cardId: bigint, token: Address, missing: bigint, hash: Hex | undefined): Promise<RedeemedInfo> {
  const [sh, feeBps] = await Promise.all([
    io.read<{ buyoutPerShard: bigint }>({ address: addresses.cardVault, abi: abi.cardVault, functionName: "shardings", args: [token] }),
    io.read<number | bigint>({ address: addresses.cardVault, abi: abi.cardVault, functionName: "feeBps" }),
  ]);
  const payoutUsdc = payoutFor(sh.buyoutPerShard, missing);
  return { kind: "redeemed", cardId, hash, buyoutPerShard: sh.buyoutPerShard, payoutUsdc, feeUsdc: (payoutUsdc * BigInt(feeBps)) / 10_000n, missing };
}

/** The approve + redeem steps. The plan is recomputed from fresh reads when a run starts, so the approval always covers what redeem pulls. */
function useRedeemSteps(s: RedeemState, c: CardData, me: Address | null) {
  const cardId = c.card?.id ?? 0n;
  const token = c.sharding?.shardToken ?? null;
  const plan = useRef<{ q: BuyoutQuote; a: AppraiseResult | undefined } | null>(null);
  const receipt = useRef<TransactionReceipt | null>(null);
  const queryClient = useQueryClient();
  // The latest appraisal from the query cache (a retry refetches it), read when a run starts rather than at render.
  const latestAppraisal = () => queryClient.getQueryData<AppraiseResult>(["appraisal", cardId.toString(), token]);

  async function redeemed(): Promise<boolean> {
    if (!token || !me) return false;
    const card = await s.io.read<{ state: number; beneficialOwner: Address }>({ address: addresses.cardVault, abi: abi.cardVault, functionName: "cards", args: [cardId] });
    return card.state !== SHARDED && card.beneficialOwner.toLowerCase() === me.toLowerCase();
  }

  async function freshPlan() {
    const ch = await readChain(s.io, token!, me!);
    const a = latestAppraisal();
    const q = buyoutQuote({ supply: ch.supply, balance: ch.balance, clearingQ96: ch.clearingQ96, appraisedUsdcPerShard: BigInt(a?.appraisal.usdcPerShard ?? "0"), feeBps: ch.feeBps });
    plan.current = { q, a };
    return { ch, q };
  }

  const redeemStep: Step = {
    id: "redeem",
    label: s.full ? "Reassemble the card (nothing to pay)" : "Buy out & redeem",
    skip: redeemed,
    run: async () => {
      // An appraisal about to expire would revert Expired: fetch a fresh one, and make sure the approval still covers
      // the new total before sending (the retry then approves the difference).
      if (!s.full) {
        const current = latestAppraisal();
        const left = current ? Number(current.appraisal.expiresAt) - Math.floor(Date.now() / 1000) : -1;
        if (left < REFRESH_BEFORE_SEC) {
          const res = await s.appraisal.refetch();
          if (res.error || !res.data) throw res.error ?? new Error("Couldn't get a fresh appraisal");
          const { ch, q } = await freshPlan();
          if (ch.allowance < q.total) throw new TxError("The price moved since the approval", { name: "ERC20InsufficientAllowance" });
        }
      }
      if (!plan.current) await freshPlan();
      const { a } = plan.current!;
      const args = s.full || !a
        ? [cardId, { cardId: 0n, shardToken: "0x0000000000000000000000000000000000000000", usdcPerShard: 0n, expiresAt: 0n }, "0x"]
        : [cardId, { cardId, shardToken: a.appraisal.shardToken, usdcPerShard: BigInt(a.appraisal.usdcPerShard), expiresAt: BigInt(a.appraisal.expiresAt) }, a.signature];
      const sent = await s.io.send({ to: addresses.cardVault, abi: abi.cardVault, functionName: "redeem", args });
      receipt.current = sent.receipt;
      return sent;
    },
  };
  const approveStep: Step = {
    id: "approve",
    label: "Approve USDC",
    skip: async () => {
      if (await redeemed()) return true;
      const { ch, q } = await freshPlan();
      return ch.allowance >= q.total;
    },
    run: () => s.io.send({ to: addresses.usdc, abi: abi.erc20, functionName: "approve", args: [addresses.cardVault, plan.current!.q.total] }),
  };
  const steps = s.full ? [redeemStep] : [approveStep, redeemStep];

  async function onDone(results: StepResult[]) {
    const r = receipt.current;
    const missing = plan.current?.q.missing ?? (s.chain ? s.chain.supply - s.chain.balance : 0n);
    plan.current = null;
    receipt.current = null;
    const info = r ? redeemedFromReceipt(cardId, missing, r) : null;
    if (info) return showVaultSuccess(info);
    // The redeem was skipped because an earlier attempt had already landed: rebuild the success from the chain.
    const hash = results.find((x) => x.id === "redeem")?.hash;
    const fromChain = token ? await redeemedFromChain(s.io, cardId, token, missing, hash).catch(() => null) : null;
    showVaultSuccess(fromChain ?? { kind: "redeemed", cardId, hash, buyoutPerShard: 0n, payoutUsdc: 0n, feeUsdc: 0n, missing });
  }
  async function onRetry() {
    plan.current = null;
    if (!s.full) {
      const res = await s.appraisal.refetch();
      if (res.error) throw res.error;
    }
    await queryClient.invalidateQueries({ queryKey: ["redeem-chain"] });
  }
  const describe = (_e: unknown, r: Revert) =>
    redeemRevert(r, s.chain?.supply ?? 0n, s.chain?.balance ?? 0n) ?? { title: r.hash ? "The transaction reverted" : "Something went wrong", body: r.hash ? "Nothing more was charged. You can try again." : r.message };
  const retryable = (r: Revert) => !["BelowThreshold", "WrongState", "ERC20InsufficientBalance"].includes(r.inner?.name ?? r.name ?? "");
  return { steps, onDone, onRetry, describe, retryable, onCancel: () => { plan.current = null; } };
}

function Row({ label, value, tone, sub, strong }: { label: React.ReactNode; value: React.ReactNode; tone?: "kin"; sub?: React.ReactNode; strong?: boolean }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b border-border py-3 last:border-0", strong && "items-center border-0 pt-5")}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("text-[14px]", strong ? "font-semibold text-text" : "text-text-2")}>{label}</span>
        {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
      </div>
      <span className={cn("shrink-0 text-right font-mono", strong ? "text-[26px] leading-none text-text" : "text-[14px]", tone === "kin" ? "text-kin" : !strong && "text-text")}>{value}</span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="flex flex-col gap-4 py-3" aria-label="Fetching the appraisal">
      {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-5 w-full bg-surface-2" />)}
    </div>
  );
}

/** The quote table (Ps4OJ left column, M3M7L5 body). `perShard` adds "/ shard" as on mobile. */
function QuoteTable({ s, c, me, perShard }: { s: RedeemState; c: CardData; me: Address | null; perShard?: boolean }) {
  const paid = usePaidTo(c, me);
  const a = s.appraisal.data;
  const q = s.quote;
  if (!q || !a) return <SkeletonRows />;
  const ps = perShard ? " / shard" : "";
  const market = money(parseUnits(a.adjustedUsd, 6), 0);
  const feePct = s.chain ? Number(s.chain.feeBps) / 100 : null;
  const paidLabel = perShard
    ? `Paid to ${paid.count} ${paid.count === 1 ? "holder" : "holders"}`
    : `Paid to ${[...paid.names, ...(paid.unclaimed > 0n ? ["auction winners"] : [])].join(", ") || "the other holders"}`;
  return (
    <div className="flex flex-col">
      <Row label="Auction clearing" value={`${money(q.clearing)}${ps}`} />
      <Row label={perShard ? `Appraisal (Scryfall ${market})` : `Appraisal · Scryfall ${market}`} value={`${money(q.appraised)}${ps}`} sub={a.priceSource} />
      <Row label={perShard ? "Buyout price" : <span className="font-semibold text-text">Buyout price, the higher</span>} value={`${money(q.price)}${ps}`} tone="kin" />
      <Row label={perShard ? "Shards you're missing" : "× shards you're missing"} value={shardsFixed(q.missing)} />
      <Row label={<span className="line-clamp-2">{paidLabel}</span>} value={money(q.payout)} />
      <Row label={`Vault fee${feePct != null ? ` ${feePct}%` : ""}`} value={money(q.fee)} />
      <Row label="You pay" value={money(q.total)} strong />
    </div>
  );
}

/** "Signed by appraiser.kura.eth · valid 9:41", counting down; the Scryfall-busy note for a cached price. */
function SignedChip({ s, short }: { s: RedeemState; short?: boolean }) {
  const a = s.appraisal.data;
  const now = s.now;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5 rounded-xl bg-bg/60 px-4 py-3 text-[13px] text-text-2">
        <BotIcon aria-hidden className="size-4 shrink-0 text-s7" />
        {a && s.quoteReady && s.left != null ? (
          <span>{short ? "Price signed" : "Signed"} by appraiser.{addresses.ensParentLabel}.eth · valid <span className="font-mono">{mmss(s.left)}</span></span>
        ) : s.appraisal.isError ? (
          <span>Couldn&apos;t refresh the appraisal · retrying shortly</span>
        ) : (
          <span>{a ? "Getting a fresh appraisal…" : "Fetching a signed appraisal…"}</span>
        )}
      </div>
      {a?.source === "snapshot" && (
        <p className="flex items-center gap-2 text-[12px] text-kin">
          <CloudOffIcon aria-hidden className="size-3.5" />
          Scryfall busy · Showing cached prices{a.pricedAt ? ` from ${Math.max(1, Math.round((now - a.pricedAt) / 60))} minutes ago` : ""}
        </p>
      )}
    </div>
  );
}

function AppraisalError({ s }: { s: RedeemState }) {
  const e = s.appraisal.error;
  const noPrice = e instanceof AppraiseError && e.code === "NO_PRICE";
  return (
    <div role="alert" className="flex flex-col items-start gap-2 rounded-xl border border-shu/30 bg-shu-soft p-3.5 text-[13px]">
      <span className="font-semibold text-text">{noPrice ? "No market price available yet, try again later" : "Couldn't get an appraisal"}</span>
      {!noPrice && <span className="text-text-2">{e?.message}</span>}
      <Button variant="secondary" size="sm" onClick={() => void s.appraisal.refetch()} disabled={s.appraisal.isFetching}>Try again</Button>
    </div>
  );
}

/** The CTA and its states: not enough USDC (shu line, disabled), the two-step note, the stepper. */
function RedeemAction({ s, c, me, compactSteps }: { s: RedeemState; c: CardData; me: Address | null; compactSteps?: boolean }) {
  const tx = useRedeemSteps(s, c, me);
  const q = s.quote;
  const ready = s.full || (s.quoteReady && !!q);
  const enough = !!q && !!s.chain && s.chain.usdc >= q.total;
  const approved = !!q && !!s.chain && s.chain.allowance >= q.total && q.total > 0n;
  return (
    <div className="flex flex-col gap-3">
      {s.appraisal.error && !s.full && <AppraisalError s={s} />}
      {ready && !s.full && !enough && s.chain && (
        <p className="text-[13px] text-shu">Not enough USDC: you pay {money(q!.total)} and hold {money(s.chain.usdc)}.</p>
      )}
      {compactSteps && !s.full && (
        <div className="flex items-center gap-4 text-[13px] text-text">
          <span className="inline-flex items-center gap-2">
            {approved ? <span className="flex size-5 items-center justify-center rounded-full bg-good text-white"><CheckIcon strokeWidth={3} className="size-3" /></span>
              : <span className="flex size-5 items-center justify-center rounded-full bg-surface-2 font-mono text-[11px]">1</span>}
            Approve USDC
          </span>
          <span className="inline-flex items-center gap-2"><span className="flex size-5 items-center justify-center rounded-full bg-surface-2 font-mono text-[11px]">2</span>Buy out &amp; redeem</span>
        </div>
      )}
      <TxStepper
        steps={tx.steps}
        cta={s.full ? "Reassemble card" : "Buy out and redeem"}
        ctaIcon={<PackageOpenIcon aria-hidden />}
        ctaClassName="h-12 rounded-xl bg-kin text-[15px] text-kin-ink hover:bg-kin/90"
        disabled={!ready || (!s.full && !enough)}
        title={s.full ? "Reassembling the card" : "Buying out the card"}
        failedTitle="The buyout didn't go through"
        retryLabel="Retry"
        onRetry={tx.onRetry}
        onCancel={tx.onCancel}
        onDone={tx.onDone}
        describeError={tx.describe}
        retryable={tx.retryable}
        successToast
        walletKind={s.io.walletKind}
      />
    </div>
  );
}

/**
 * The shortfall's price on the card's pool (V4 Quoter exact-out) and "Buy from pool", which fills the market form with
 * that much USDC plus 1% headroom. `onCardPage`: the form is on this page (scroll to it), else go to the card page.
 */
function BuyShortfall({ c, short, onCardPage }: { c: CardData; short: bigint; onCardPage: boolean }) {
  const io = useMarketIo();
  const pool = c.pool ?? null;
  const q = useQuery({
    queryKey: ["shortfall-quote", pool?.poolId ?? null, short.toString()],
    queryFn: () => quoteBuyExactShards({ key: poolKeyOf(pool!, io.addresses), shards: short }, io),
    enabled: isTradable(pool) && short > 0n,
    retry: false,
    refetchInterval: 30_000,
  });
  if (!isTradable(pool) || short <= 0n) return null;
  const budget = q.data != null ? shortfallBudget(q.data) : null;
  const fill = () => prefillMarket({
    cardId: c.card!.id, side: "buy", amount: formatUsdcInput(budget!),
    note: `Buys the ${shardsFixed(short)} shards you're short of 80%, with 1% headroom for the price moving.`,
  });
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg/60 p-4">
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="text-text-2">Buy the {shardsFixed(short)} from the pool</span>
        <span className="font-mono text-text">{q.data != null ? `≈ ${money(q.data)}` : q.isError ? "n/a" : "quoting…"}</span>
      </div>
      {q.isError && <p className="text-[12px] text-shu">The pool can&apos;t sell that many shards right now.</p>}
      {onCardPage ? (
        <Button variant="secondary" size="md" disabled={budget == null} onClick={fill}><ArrowLeftRightIcon aria-hidden />Buy from pool</Button>
      ) : (
        <Button asChild variant="secondary" size="md" disabled={budget == null}>
          <Link href={`/app/cards/${c.card!.id}#market`} onClick={budget != null ? fill : undefined}><ArrowLeftRightIcon aria-hidden />Buy from pool</Link>
        </Button>
      )}
    </div>
  );
}

/** mnpO6 "Below 80%": how far from redeeming, in place of the redeem panel. */
export function BelowThresholdCard({ c, balance, supply, onSend, holdersHref, onCardPage = true }: { c: CardData; balance: bigint; supply: bigint; onSend?: () => void; holdersHref: string; onCardPage?: boolean }) {
  const short = shardsShort(balance, supply);
  const total = c.sharding?.totalShards ?? 0;
  return (
    <Panel className="flex flex-col gap-4 p-6 md:p-7">
      <span className="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-s1"><KeyRoundIcon aria-hidden className="size-5" /></span>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-[18px] font-semibold text-text">{shardsFixed(short)} shards short</h2>
        <p className="text-[14px] text-text-2">
          You hold {shardsFixed(balance)} of {total}. {isTradable(c.pool ?? null) ? "Buy the rest from the pool to reach 80% and redeem." : "Buy shards or wait for the next auction to reach 80% and redeem."}
        </p>
      </div>
      <RedemptionMeter value={shareOf(balance, supply)} label="Distance to redemption" status={`${(shareOf(balance, supply) * 100).toFixed(1)}% · needs 80%`} />
      <BuyShortfall c={c} short={short} onCardPage={onCardPage} />
      <div className="flex flex-wrap gap-2.5">
        <Button asChild variant="secondary" size="md"><Link href={holdersHref} scroll={false}>See holders</Link></Button>
        {onSend && <Button variant="secondary" size="md" onClick={onSend}><SendIcon aria-hidden />Send shards</Button>}
      </div>
    </Panel>
  );
}

/**
 * The redeem panel of a sharded card for a holder (Ps4OJ on desktop; on mobile a summary that opens the M3M7L5 page).
 * Below 80% it is the mnpO6 "shards short" card; a full holder reassembles the card for nothing.
 */
export function RedeemPanel({ c, me, fallback = null }: { c: CardData; me: Address | null; /** Shown when the live balance is zero (not a holder). */ fallback?: React.ReactNode }) {
  const s = useRedeem(c, me);
  const [sending, setSending] = useState(false);
  const id = c.card!.id.toString();
  if (!me || !c.sharding) return <>{fallback}</>;
  // Gated on the live balanceOf: the indexer's balance only decides what shows while the chain read loads.
  // While the token's holders load too, a zero indexer balance is "unknown", not "not a holder".
  if (!s.chain) return c.myBalance > 0n || c.holdersLoading ? <Panel className="p-6 md:p-7"><SkeletonRows /></Panel> : <>{fallback}</>;
  if (s.chain.balance === 0n) return <>{fallback}</>;
  const send = (
    <SendShardsSheet open={sending} onOpenChange={setSending} cardName={cardName(c)} shardToken={c.sharding.shardToken} balance={s.chain.balance} supply={s.chain.supply} />
  );
  if (!s.eligible) {
    return <>{<BelowThresholdCard c={c} balance={s.chain.balance} supply={s.chain.supply} onSend={() => setSending(true)} holdersHref={`/app/cards/${id}?tab=holders`} />}{send}</>;
  }
  const share = shareOf(s.chain.balance, s.chain.supply);
  const missing = shardsFixed(s.chain.supply - s.chain.balance, 0);
  const sentence = s.full
    ? `You hold every one of the ${c.sharding.totalShards} shards. Reassemble the card: nothing to pay.`
    : `You hold ${shardsFixed(s.chain.balance)} of ${c.sharding.totalShards} shards (${(share * 100).toFixed(1)}%). Buy out the other ${missing} and the physical card is yours.`;
  return (
    <>
      {/* Mobile: the position summary; the full quote is its own page (M3M7L5). */}
      <Panel className="flex flex-col gap-4 p-5 md:hidden">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-kin-soft text-kin"><KeyRoundIcon aria-hidden className="size-5" /></span>
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-[20px] leading-tight font-semibold text-text">You can take this card home</h2>
            <p className="text-[13px] text-text-2">{sentence}</p>
          </div>
        </div>
        <RedemptionMeter value={share} label="Redemption" status="eligible at 80%" fillClassName="bg-kin" className="[&>div:first-child>span:last-child]:text-kin" />
        <div className="grid grid-cols-2 gap-2.5">
          <Button asChild variant="redeem" size="md" className="h-12 rounded-xl"><Link href={`/app/cards/${id}/redeem`}><PackageOpenIcon aria-hidden />Redeem</Link></Button>
          <Button variant="secondary" size="md" className="h-12 rounded-xl" onClick={() => setSending(true)}><SendIcon aria-hidden />Send</Button>
        </div>
      </Panel>
      {/* Desktop: Ps4OJ. */}
      <Panel className="overflow-hidden border-kin/40 max-md:hidden">
        <div className="flex items-start gap-5 border-b border-border p-7">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-kin-soft text-kin"><KeyRoundIcon aria-hidden className="size-6" /></span>
          <div className="flex flex-col gap-1.5">
            <h2 className="font-display text-[28px] leading-tight font-semibold text-text">You can take this card home</h2>
            <p className="text-[14px] text-text-2">{sentence}</p>
          </div>
        </div>
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="px-7 py-4 lg:border-r lg:border-border">
            {s.full ? <Row label="Shards you're missing" value="0.0" /> : s.appraisal.error ? <p className="py-3 text-[13px] text-text-2">The quote appears once the appraisal is signed.</p> : <QuoteTable s={s} c={c} me={me} />}
          </div>
          <div className="flex flex-col gap-4 p-7">
            {!s.full && <SignedChip s={s} />}
            <div className="flex items-center justify-between text-[14px]">
              <span className="text-text-2">Your USDC</span>
              <span className="font-mono text-text">{money(s.chain.usdc).slice(1)}</span>
            </div>
            <RedeemAction s={s} c={c} me={me} />
            <p className="text-[12px] text-muted-foreground">
              {s.full ? "1 step · redeem." : "2 steps · approve USDC, redeem."} Then pick up the card at the counter with a Passport check.
            </p>
            <div className="border-t border-border pt-3">
              <button type="button" onClick={() => setSending(true)} className="inline-flex items-center gap-2 text-[13px] text-text-2 hover:text-text">
                <SendIcon aria-hidden className="size-4" />Or send shards to a friend
              </button>
            </div>
          </div>
        </div>
      </Panel>
      {send}
    </>
  );
}

const cardName = (c: CardData) => (c.meta ? metaCardName(c.meta.name) : c.card?.label ?? "card");

/** M3M7L5: the full-page redeem flow (mobile first; also works on desktop). */
export function RedeemPage({ c, me, identity }: { c: CardData; me: Address | null; identity: { name: string; image: string | null } }) {
  const s = useRedeem(c, me);
  const id = c.card!.id.toString();
  if (!me) return <p className="text-[14px] text-text-2">Log in to redeem.</p>;
  if (c.shardingsLoading) return <SkeletonRows />;
  if (!c.sharding) return <p className="text-[14px] text-text-2">This card isn&apos;t sharded.</p>;
  if (!s.chain) return <SkeletonRows />;
  if (!s.eligible) return <BelowThresholdCard c={c} balance={s.chain.balance} supply={s.chain.supply} holdersHref={`/app/cards/${id}?tab=holders`} onCardPage={false} />;
  const share = shareOf(s.chain.balance, s.chain.supply);
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <div className="flex items-center gap-4">
        {identity.image ? (
          // eslint-disable-next-line @next/next/no-img-element -- Scryfall art, sized by the container
          <img src={identity.image} alt="" className="aspect-[63/88] w-24 shrink-0 rounded-lg object-cover" />
        ) : <div className="aspect-[63/88] w-24 shrink-0 rounded-lg bg-surface-2" />}
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="font-display text-[28px] leading-tight font-semibold text-text">{identity.name}</h1>
          <span className="truncate font-mono text-[12px] text-kin">{c.card!.ensName}</span>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-kin-soft px-2.5 py-1 text-[12px] font-semibold text-kin">
            <KeyRoundIcon aria-hidden className="size-3.5" />You hold {(share * 100).toFixed(1)}% · eligible
          </span>
        </div>
      </div>
      {s.full ? <Row label="Shards you're missing" value="0.0" /> : s.appraisal.error ? null : <QuoteTable s={s} c={c} me={me} perShard />}
      {!s.full && <SignedChip s={s} short />}
      <div className="flex flex-col gap-3 border-t border-border pt-4 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:bg-bg/95 max-md:px-4 max-md:pb-[calc(1rem+env(safe-area-inset-bottom))] max-md:backdrop-blur">
        <RedeemAction s={s} c={c} me={me} compactSteps />
        <p className="text-[12px] text-muted-foreground">Other holders claim their USDC any time. Then pick up the card at the vault with a Passport check.</p>
      </div>
      <div aria-hidden className="h-44 md:hidden" />
    </div>
  );
}
