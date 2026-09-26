"use client";

import type * as React from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRightIcon, CheckIcon, CoinsIcon, ExternalLinkIcon, LockIcon } from "lucide-react";
import type { Address, Hex, Log } from "viem";
import { abi } from "@kura/shared";
import { AmountInput, Button, Segmented, notify } from "@/components/kura";
import { Panel, Stat } from "@/components/card-state-panel";
import { parseShardAmount } from "@/components/send-shards";
import { TxStepper, describeTxError } from "@/components/tx-stepper";
import type { CardData } from "@/hooks/use-card";
import { useKuraUser } from "@/hooks/use-kura-user";
import { addresses, explorerTx, publicClient } from "@/lib/chain";
import { clearingPerShard } from "@/lib/card-view";
import { money, shardsFixed, shortHash } from "@/lib/format";
import {
  DEFAULT_SLIPPAGE_BPS,
  buildSwapSteps,
  feesFromReceipt,
  impliedCardValue,
  isTradable,
  livePrice,
  marketPrice,
  pctDelta,
  poolKeyOf,
  quoteExactIn,
  swapFromReceipt,
  swapRevertMessage,
  type MarketChain,
  type PoolRow,
  type SwapSide,
} from "@/lib/market";
import { isZeroForOne } from "@kura/shared";
import { marketPerShard, quoteUsdc } from "@/lib/pricing";
import { parseUsdcInput } from "@/lib/shard-math";
import { decodeRevert, useSendTx, type Revert, type Sent, type Step, type WalletKind } from "@/lib/tx";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------------------------------------------------
// Chain access (live: viem and Privy; tests and /design previews pass fixtures through MarketIoContext)

export type MarketIo = MarketChain & { walletKind: WalletKind | null };
export const MarketIoContext = createContext<Partial<MarketIo> | null>(null);

export function useMarketIo(): MarketIo {
  const override = useContext(MarketIoContext);
  const live = useSendTx();
  const read = useCallback(<T,>(req: Parameters<MarketChain["read"]>[0]) => publicClient.readContract(req as never) as Promise<T>, []);
  const simulate = useCallback((req: Parameters<MarketChain["simulate"]>[0]) => publicClient.simulateContract(req as never) as Promise<{ result: unknown }>, []);
  return {
    read: override?.read ?? read,
    simulate: override?.simulate ?? simulate,
    send: override?.send ?? live.send,
    now: override?.now,
    addresses: override?.addresses ?? addresses,
    walletKind: override?.walletKind !== undefined ? override.walletKind : live.walletKind,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Prefill: the redeem panel's "Buy from pool" fills the form here.

export type MarketPrefill = { cardId: bigint; side: SwapSide; amount: string; note?: string; nonce: number };
let prefill: MarketPrefill | null = null;
const prefillListeners = new Set<() => void>();
let nonce = 0;

/** Fill the card's market form (side and amount) and scroll it into view. */
export function prefillMarket(p: Omit<MarketPrefill, "nonce">) {
  prefill = { ...p, nonce: ++nonce };
  prefillListeners.forEach((l) => l());
  if (typeof document !== "undefined") document.getElementById("market")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

function usePrefill(cardId: bigint): MarketPrefill | null {
  const v = useSyncExternalStore(
    (cb) => {
      prefillListeners.add(cb);
      return () => prefillListeners.delete(cb);
    },
    () => prefill,
    () => null,
  );
  return v && v.cardId === cardId ? v : null;
}

// ---------------------------------------------------------------------------------------------------------------------

const deltaText = (d: number | null) => (d == null ? "n/a" : `${d > 0 ? "+" : ""}${d.toFixed(1)}%`);
const deltaTone = (d: number | null) => (d == null || Math.abs(d) < 0.05 ? undefined : d > 0 ? "good" : "shu") as "good" | "shu" | undefined;

type Done = { side: SwapSide; shards: bigint; usdc: bigint; hash: Hex | undefined };

/**
 * The card's Uniswap pool (sharded state): live price per shard, implied card value against the appraisal and the
 * clearing, a Buy / Sell form through Permit2 and the Universal Router, and "Collect fees" for the LP owner. Hidden when
 * the card has no pool; after a buyout it says trading closed.
 */
export function MarketPanel({ c, me }: { c: CardData; me: Address | null }) {
  const pool = c.pool ?? null;
  if (!pool) return null;
  return <MarketBody c={c} pool={pool} me={me} />;
}

function MarketBody({ c, pool, me }: { c: CardData; pool: PoolRow; me: Address | null }) {
  const io = useMarketIo();
  const tradable = isTradable(pool);
  const live = useQuery({
    queryKey: ["pool-slot0", pool.poolId],
    queryFn: () => livePrice(pool, io),
    enabled: tradable,
    refetchInterval: 12_000,
  });
  const price = marketPrice(pool, live.data?.priceUsdcPerShard ?? null);
  const sharding = c.sharding ?? c.allShardings.find((s) => s.shardToken.toLowerCase() === pool.shardToken.toLowerCase()) ?? null;
  const totalShards = sharding?.totalShards ?? 0;
  const implied = impliedCardValue(price, totalShards);
  const appraisal = marketPerShard(quoteUsdc(c.price), totalShards);
  const clearing = clearingPerShard(sharding);
  const vsAppraisal = pctDelta(price, appraisal);
  const vsClearing = pctDelta(price, clearing);
  const isLp = !!me && me.toLowerCase() === pool.lpOwner.toLowerCase();

  return (
    <Panel className="flex flex-col gap-6 p-6 md:p-7">
      <div id="market" className="flex scroll-mt-24 flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-surface-2 text-s1"><ArrowLeftRightIcon aria-hidden className="size-4" /></span>
          <h2 className="font-display text-[22px] font-semibold text-text">{tradable ? "Trade shards" : "Trading closed at buyout"}</h2>
        </div>
        <p className="text-[13px] text-text-2">
          {tradable
            ? "A Uniswap pool opened at the auction's clearing price. Buy or sell shards any time until the card is bought out."
            : "The card was bought out, so the pool no longer takes swaps or new liquidity. Liquidity providers can still withdraw, and every shard is paid out at the buyout price."}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
        <Stat label={tradable ? "Pool price" : "Last price"} value={price != null ? money(price) : "n/a"} sub="per shard" />
        <Stat label="Implied value" value={implied != null ? money(implied, 0) : "n/a"} sub={`price × ${totalShards} shards`} />
        <Stat label="vs appraisal" value={deltaText(vsAppraisal)} tone={deltaTone(vsAppraisal)} sub={appraisal != null ? `${money(appraisal)} / shard` : "no market price"} />
        <Stat label="vs clearing" value={deltaText(vsClearing)} tone={deltaTone(vsClearing)} sub={clearing != null ? `${money(clearing)} / shard` : "no clearing"} />
      </div>
      {tradable && <TradeForm c={c} pool={pool} me={me} io={io} price={price} />}
      {isLp && <CollectFees pool={pool} io={io} tradable={tradable} />}
    </Panel>
  );
}

/** Debounced: the quote follows the typed amount once typing pauses. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function TradeForm({ c, pool, me, io, price }: { c: CardData; pool: PoolRow; me: Address | null; io: MarketIo; price: bigint | null }) {
  const { login } = useKuraUser();
  const cardId = pool.cardId;
  const [side, setSide] = useState<SwapSide>("buy");
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const receipt = useRef<{ logs: readonly Log[] } | null>(null);
  const pre = usePrefill(cardId);
  const applied = useRef(0);
  useEffect(() => {
    if (!pre || pre.nonce === applied.current) return;
    applied.current = pre.nonce;
    setSide(pre.side);
    setText(pre.amount);
    setNote(pre.note ?? null);
    setDone(null);
  }, [pre]);

  const key = poolKeyOf(pool, io.addresses);
  const amountIn = side === "buy" ? parseUsdcInput(text || "0") ?? null : text ? parseShardAmount(text) : 0n;
  const debounced = useDebounced(amountIn, 350);
  const shardToken = pool.shardToken as Address;

  const balances = useQuery({
    queryKey: ["market-balances", shardToken, me?.toLowerCase() ?? null],
    queryFn: async () => {
      const [usdc, shards] = await Promise.all([
        io.read<bigint>({ address: io.addresses.usdc, abi: abi.erc20, functionName: "balanceOf", args: [me] }),
        io.read<bigint>({ address: shardToken, abi: abi.erc20, functionName: "balanceOf", args: [me] }),
      ]);
      return { usdc, shards };
    },
    enabled: !!me,
    refetchInterval: 12_000,
  });
  const balance = side === "buy" ? balances.data?.usdc ?? null : balances.data?.shards ?? c.myBalance;

  // The quote and the steps for exactly this amount. Not refetched in the background: the steps must not change while
  // the stepper runs them (the wallet popup's focus change would otherwise rebuild them mid-run).
  const plan = useQuery({
    queryKey: ["swap-plan", pool.poolId, side, debounced?.toString() ?? null, me?.toLowerCase() ?? null],
    queryFn: async () => {
      if (me) return buildSwapSteps({ side, amountIn: debounced!, key, account: me }, io);
      const quote = await quoteExactIn({ key, zeroForOne: isZeroForOne(side, pool.shardIsCurrency0), amountIn: debounced! }, io);
      return { quote, amountOutMin: (quote * BigInt(10_000 - DEFAULT_SLIPPAGE_BPS)) / 10_000n, steps: [] as Step[] };
    },
    enabled: debounced != null && debounced > 0n,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const fresh = debounced === amountIn;
  const q = fresh ? plan.data : undefined;
  const over = amountIn != null && balance != null && amountIn > balance;
  const invalid = text !== "" && amountIn == null;

  if (done) {
    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-good/40 bg-good-soft/30 p-5" aria-live="polite">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-good-soft text-good-fg"><CheckIcon aria-hidden className="size-5" strokeWidth={2.5} /></span>
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="font-display text-[22px] leading-tight font-semibold text-text">{done.side === "buy" ? `Bought ${shardsFixed(done.shards, 3)} shards` : `Sold ${shardsFixed(done.shards, 3)} shards`}</h3>
            <p className="text-[13px] text-text-2">
              For {money(done.usdc)}
              {done.shards > 0n ? ` · ${money((done.usdc * 10n ** 18n) / done.shards)} per shard` : ""}. {done.side === "buy" ? "The shards are in your wallet." : "The USDC is in your wallet."}
            </p>
          </div>
        </div>
        {done.hash && (
          <a href={explorerTx(done.hash)} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text-2 hover:text-text">
            swap {shortHash(done.hash)}<ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        )}
        <Button variant="secondary" size="md" onClick={() => { setDone(null); setText(""); setNote(null); }}>Trade again</Button>
      </div>
    );
  }

  const steps = (q?.steps ?? []).map((s) => (s.id === "swap" ? { ...s, run: async (): Promise<Sent> => { const sent = await s.run(); receipt.current = sent.receipt; return sent; } } : s));
  const unit = side === "buy" ? "USDC" : "shards";
  const outUnit = (x: bigint) => (side === "buy" ? `${shardsFixed(x, 3)} shards` : money(x));
  const avg = q && amountIn && q.quote > 0n
    ? side === "buy" ? (amountIn * 10n ** 18n) / q.quote : (q.quote * 10n ** 18n) / amountIn
    : null;
  const errName = (r: Revert) => r.inner?.name ?? r.name;
  const quoteError = plan.error ? decodeRevert(plan.error) : null;

  return (
    <div className="flex flex-col gap-4">
      <Segmented
        label="Buy or sell"
        options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]}
        value={side}
        onChange={(v) => { setSide(v); setText(""); setNote(null); }}
      />
      {note && <p className="rounded-lg bg-kin-soft px-3.5 py-2.5 text-[12px] text-kin">{note}</p>}
      <AmountInput
        label={side === "buy" ? "You pay" : "You sell"}
        unit={unit}
        placeholder={side === "buy" ? "100.00" : "1.0"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        tone={over || invalid ? "shu" : "default"}
        hint={
          invalid ? `Enter an amount in ${unit}.`
          : over ? `You have ${side === "buy" ? money(balance!) : `${shardsFixed(balance!, 3)} shards`}.`
          : balance != null ? `Balance ${side === "buy" ? money(balance) : `${shardsFixed(balance, 3)} shards`}`
          : undefined
        }
        hintClassName={over || invalid ? "text-shu" : undefined}
      />
      {amountIn != null && amountIn > 0n && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-bg/60 p-3.5 text-[12px]">
          {quoteError && !plan.isFetching ? (
            <p role="alert" className="text-shu">{swapRevertMessage(quoteError.inner?.name ?? quoteError.name)?.title ?? "Couldn't get a quote for this amount"}. Try a different amount.</p>
          ) : (
            <>
              <QuoteRow label="You receive" value={q ? `≈ ${outUnit(q.quote)}` : "quoting…"} />
              <QuoteRow label={`Minimum, ${DEFAULT_SLIPPAGE_BPS / 100}% slippage`} value={q ? outUnit(q.amountOutMin) : "…"} />
              <QuoteRow label="Average price" value={avg != null ? `${money(avg)} / shard` : price != null ? `pool ${money(price)} / shard` : "…"} />
              <p className="text-[11px] text-muted-foreground">Includes the pool&apos;s 1% fee, paid to its liquidity providers.</p>
            </>
          )}
        </div>
      )}
      {me ? (
        <TxStepper
          steps={steps}
          cta={side === "buy" ? "Buy shards" : "Sell shards"}
          ctaIcon={<ArrowLeftRightIcon aria-hidden />}
          ctaClassName="h-12 rounded-xl text-[15px]"
          disabled={!q || steps.length === 0 || over || invalid || !amountIn}
          title={side === "buy" ? "Buying shards" : "Selling shards"}
          failedTitle="The trade didn't go through"
          walletKind={io.walletKind}
          successToast={false}
          describeError={(e, r) => swapRevertMessage(errName(r)) ?? describeTxError(e, r)}
          retryable={(r) => !["V4TooLittleReceived", "Frozen"].includes(errName(r) ?? "")}
          backLabel="Get a new quote"
          onCancel={() => void plan.refetch()}
          onDone={(results) => {
            const hash = results.find((r) => r.id === "swap")?.hash;
            const got = receipt.current ? swapFromReceipt(receipt.current.logs, cardId, io.addresses.shardMarket) : null;
            receipt.current = null;
            const d: Done = got
              ? { ...got, hash }
              : { side, shards: side === "buy" ? q!.amountOutMin : amountIn!, usdc: side === "buy" ? amountIn! : q!.amountOutMin, hash };
            setDone(d);
            notify({
              title: d.side === "buy" ? "Shards bought" : "Shards sold",
              body: `${shardsFixed(d.shards, 3)} shards for ${money(d.usdc)}`,
              tone: "good",
              icon: <CheckIcon />,
            });
          }}
        />
      ) : (
        <Button variant="secondary" size="md" className="h-12 w-full rounded-xl" onClick={() => login()}><LockIcon aria-hidden />Log in to trade</Button>
      )}
      {me && q && q.steps.length > 1 && (
        <p className="text-[12px] text-muted-foreground">{q.steps.length} steps: {q.steps.map((s) => (s.id === "swap" ? "swap" : s.id === "permit2" ? "allow the router" : "approve")).join(", ")}.</p>
      )}
    </div>
  );
}

function QuoteRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-2">{label}</span>
      <span className="font-mono text-[13px] text-text">{value}</span>
    </div>
  );
}

/** The LP owner's "Collect fees": the locked positions' swap fees, sent to them by `collectFees(cardId)`. */
function CollectFees({ pool, io, tradable }: { pool: PoolRow; io: MarketIo; tradable: boolean }) {
  const receipt = useRef<{ logs: readonly Log[] } | null>(null);
  const [collected, setCollected] = useState<{ shards: bigint; usdc: bigint; hash: Hex | undefined } | null>(null);
  const steps: Step[] = [{
    id: "collect",
    label: "Collect the pool's trading fees",
    run: async () => {
      const sent = await io.send({ to: io.addresses.shardMarket, abi: abi.shardMarket, functionName: "collectFees", args: [pool.cardId] });
      receipt.current = sent.receipt;
      return sent;
    },
  }];
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-kin-soft text-kin"><CoinsIcon aria-hidden className="size-4" /></span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-[15px] font-semibold text-text">Your pool fees</h3>
          <p className="text-[13px] text-text-2">
            {tradable ? "You earn the pool's 1% trading fee on the liquidity the auction seeded, until the card is bought out." : "At buyout the pool's liquidity and fees came back to you."}
            {" "}Collected so far: <span className="font-mono text-text">{money(pool.feesUsdc)}</span> and <span className="font-mono text-text">{shardsFixed(pool.feesShards, 3)} shards</span>.
          </p>
        </div>
      </div>
      {collected ? (
        <p className={cn("flex flex-wrap items-center gap-2 rounded-lg bg-good-soft px-3.5 py-2.5 text-[12px] text-good-fg")} aria-live="polite">
          <CheckIcon aria-hidden className="size-4 shrink-0" />
          Collected {money(collected.usdc)} and {shardsFixed(collected.shards, 3)} shards.
          {collected.hash && <a href={explorerTx(collected.hash)} target="_blank" rel="noreferrer" className="font-mono hover:underline">{shortHash(collected.hash)}</a>}
        </p>
      ) : tradable ? (
        <TxStepper
          steps={steps}
          cta="Collect fees"
          ctaIcon={<CoinsIcon aria-hidden />}
          title="Collecting fees"
          failedTitle="The fees weren't collected"
          walletKind={io.walletKind}
          successToast={false}
          onDone={(results) => {
            const got = receipt.current ? feesFromReceipt(receipt.current.logs, pool.cardId, io.addresses.shardMarket) : null;
            receipt.current = null;
            const c = { shards: got?.shards ?? 0n, usdc: got?.usdc ?? 0n, hash: results.find((r) => r.id === "collect")?.hash };
            setCollected(c);
            notify({ title: "Fees collected", body: `${money(c.usdc)} and ${shardsFixed(c.shards, 3)} shards`, tone: "good", icon: <CheckIcon /> });
          }}
        />
      ) : null}
    </div>
  );
}
