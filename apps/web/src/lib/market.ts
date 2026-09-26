// The shard market: each settled card's Uniswap v4 pool (shards vs USDC, ShardMarket as the hook). Indexer reads, the
// live price from StateView, quotes from the V4 Quoter and the swap steps through Permit2 and the Universal Router.
// Chain access is injected (`MarketChain`), so node tests cover all of it.
import { desc, eq } from "@ponder/client";
import { isAddressEqual, maxUint160, maxUint256, parseEventLogs, type Abi, type Address, type Hex, type Log } from "viem";
import {
  KURA_POOL_FEE,
  KURA_TICK_SPACING,
  abi,
  encodeExactInSingleSwap,
  isZeroForOne,
  sortCurrencies,
  stateViewAbi,
  universalRouterAbi,
  usdcPerShardFromSqrtPrice,
  v4QuoterAbi,
  type PoolKey,
} from "@kura/shared";
import * as schema from "../../../indexer/ponder.schema";
import { t, type Row } from "@/lib/ponder-bridge";
import { money, shardsFixed } from "@/lib/format";
import type { SendInput, Sent, Step } from "@/lib/tx-core";

export type PoolRow = Row<typeof schema.pools>;
export type SwapRow = Row<typeof schema.swaps>;
export type SwapSide = "buy" | "sell";

const lc = (a: string) => a.toLowerCase();

/** Default slippage: 1%. */
export const DEFAULT_SLIPPAGE_BPS = 100;
/** A Permit2 allowance that expires sooner than this is renewed, so it can't lapse before the swap mines. */
const PERMIT2_MARGIN_SEC = 600;
const PERMIT2_TTL_SEC = 30 * 86_400;
/** The Universal Router deadline: 20 minutes from signing. */
const DEADLINE_SEC = 20 * 60;

export type MarketAddresses = { usdc: Address; permit2: Address; universalRouter: Address; v4Quoter: Address; stateView: Address; shardMarket: Address };
export type ReadRequest = { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] };
export type SimulateRequest = ReadRequest & { account?: Address };

/** How the market reaches the chain. Live: viem's public client and `useSendTx`; tests and previews pass fakes. */
export type MarketChain = {
  read: <T = unknown>(req: ReadRequest) => Promise<T>;
  simulate: (req: SimulateRequest) => Promise<{ result: unknown }>;
  send: (input: SendInput) => Promise<Sent>;
  /** Unix seconds. */
  now?: () => number;
  addresses: MarketAddresses;
};

type Db = { select: () => unknown };
type Query<T> = { from: (x: never) => Query<T>; where: (x: never) => Query<T>; orderBy: (...x: never[]) => Query<T>; limit: (n: number) => Promise<T[]> };

// ---------------------------------------------------------------------------------------------------------------------
// Indexer

/** The card's pool row from the indexer, or null when it has none (the auction never graduated, or not yet settled). */
/**
 * The card's pool query: at most one row, none when the card has no pool. Returned unexecuted, like every
 * usePonderQuery queryFn, so the hook can compile it to SQL and keep it live.
 */
export function loadPool(db: Db, cardId: bigint): Promise<PoolRow[]> {
  const q = db.select() as Query<PoolRow>;
  return q.from(t(schema.pools)).where(t(eq(t(schema.pools.cardId), cardId))).limit(1);
}

/** The card's latest swaps query, newest first. Returned unexecuted, like loadPool. */
export function loadSwaps(db: Db, cardId: bigint, limit: number): Promise<SwapRow[]> {
  const q = db.select() as Query<SwapRow>;
  return q.from(t(schema.swaps)).where(t(eq(t(schema.swaps.cardId), cardId))).orderBy(t(desc(t(schema.swaps.blockNumber)))).limit(limit);
}

// ---------------------------------------------------------------------------------------------------------------------
// Prices

/** The pool's v4 key: the shard token sorted against USDC, 1% fee, tick spacing 200, ShardMarket as the hook. */
export function poolKeyOf(pool: Pick<PoolRow, "shardToken">, a: Pick<MarketAddresses, "usdc" | "shardMarket">): PoolKey {
  const { currency0, currency1 } = sortCurrencies(pool.shardToken as Address, a.usdc);
  return { currency0, currency1, fee: KURA_POOL_FEE, tickSpacing: KURA_TICK_SPACING, hooks: a.shardMarket };
}

/** The pool's live price from StateView `getSlot0`: USDC raw units per whole shard. Null without a pool. */
export async function livePrice(
  pool: Pick<PoolRow, "poolId" | "shardIsCurrency0"> | null,
  chain: Pick<MarketChain, "read" | "addresses">,
): Promise<{ sqrtPriceX96: bigint; priceUsdcPerShard: bigint } | null> {
  if (!pool) return null;
  const [sqrtPriceX96] = await chain.read<readonly [bigint, number, number, number]>({
    address: chain.addresses.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [pool.poolId],
  });
  return { sqrtPriceX96, priceUsdcPerShard: usdcPerShardFromSqrtPrice(sqrtPriceX96, pool.shardIsCurrency0) };
}

/** The price to show: the live one, else the indexer's latest. Null without a pool or for a zero price (never NaN). */
export function marketPrice(pool: Pick<PoolRow, "priceUsdcPerShard"> | null, live: bigint | null): bigint | null {
  if (!pool) return null;
  const p = live != null && live > 0n ? live : pool.priceUsdcPerShard;
  return p > 0n ? p : null;
}

/** What the whole card is worth at the pool price: price per shard × shard count. */
export function impliedCardValue(priceUsdcPerShard: bigint | null, totalShards: number): bigint | null {
  return priceUsdcPerShard == null ? null : priceUsdcPerShard * BigInt(totalShards);
}

/** `a` against `b` in percent (10 = 10% above), or null when there's nothing to compare against. */
export function pctDelta(a: bigint | null, b: bigint | null): number | null {
  if (a == null || b == null || b === 0n) return null;
  return Number(((a - b) * 1_000_000n) / b) / 10_000;
}

/** What valuations need from a pool row. */
export type PoolPrice = Pick<PoolRow, "cardId" | "priceUsdcPerShard" | "frozen"> & { shardToken: string };

/**
 * The pool price holdings of `shardToken` are valued at: the indexer's latest pool price while the pool trades. Null
 * without a pool, once it is frozen (bought out: the buyout price takes over) or at a zero price.
 */
export function poolValuePrice(pools: readonly PoolPrice[] | undefined, shardToken: string): bigint | null {
  const p = pools?.find((x) => lc(x.shardToken) === lc(shardToken));
  return p && !p.frozen && p.priceUsdcPerShard > 0n ? p.priceUsdcPerShard : null;
}

/** Whether the pool takes swaps: it exists and the card hasn't been bought out. */
export const isTradable = (pool: Pick<PoolRow, "frozen"> | null): boolean => !!pool && !pool.frozen;

/**
 * The chart's "Pool price" series in dollars per shard, oldest first: the opening price at seed, then the pool price
 * after each swap (from its sqrtPriceX96, else its execution price).
 */
export function swapSeries(swaps: readonly SwapRow[], pool: Pick<PoolRow, "seededAt" | "priceUsdcPerShard" | "shardIsCurrency0"> | null, openingUsdc: bigint | null): { t: number; usd: number }[] {
  if (!pool) return [];
  const usd = (x: bigint) => Number(x) / 1e6;
  const out: { t: number; usd: number }[] = [];
  if (openingUsdc != null && openingUsdc > 0n) out.push({ t: Number(pool.seededAt), usd: usd(openingUsdc) });
  const sorted = [...swaps].sort((a, b) => (a.blockNumber === b.blockNumber ? a.id.localeCompare(b.id) : a.blockNumber < b.blockNumber ? -1 : 1));
  for (const s of sorted) {
    const after = s.sqrtPriceX96 > 0n ? usdcPerShardFromSqrtPrice(s.sqrtPriceX96, pool.shardIsCurrency0) : s.priceUsdcPerShard;
    out.push({ t: Number(s.timestamp), usd: usd(after) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Quotes and swaps

const quoteParams = (key: PoolKey, zeroForOne: boolean, exactAmount: bigint) => ({ poolKey: key, zeroForOne, exactAmount, hookData: "0x" as Hex });

/** The V4 Quoter's exact-in quote: what `amountIn` gets out of the pool. Throws when the pool refuses (frozen). */
export async function quoteExactIn(p: { key: PoolKey; zeroForOne: boolean; amountIn: bigint; account?: Address }, chain: Pick<MarketChain, "simulate" | "addresses">): Promise<bigint> {
  const { result } = await chain.simulate({
    address: chain.addresses.v4Quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: [quoteParams(p.key, p.zeroForOne, p.amountIn)], account: p.account,
  });
  return (result as readonly [bigint, bigint])[0];
}

/** The V4 Quoter's exact-out quote: the USDC it takes to buy exactly `shards` from the pool. */
export async function quoteBuyExactShards(p: { key: PoolKey; shards: bigint; account?: Address }, chain: Pick<MarketChain, "simulate" | "addresses">): Promise<bigint> {
  const shardIsCurrency0 = lc(p.key.currency0) !== lc(chain.addresses.usdc);
  const { result } = await chain.simulate({
    address: chain.addresses.v4Quoter, abi: v4QuoterAbi, functionName: "quoteExactOutputSingle", args: [quoteParams(p.key, isZeroForOne("buy", shardIsCurrency0), p.shards)], account: p.account,
  });
  return (result as readonly [bigint, bigint])[0];
}

/** The USDC to spend for an exact-out quote through the exact-in form: the quote plus 1% headroom, rounded up to a cent. */
export function shortfallBudget(quoteUsdc: bigint): bigint {
  const withHeadroom = (quoteUsdc * 10_100n + 9_999n) / 10_000n;
  return ((withHeadroom + 9_999n) / 10_000n) * 10_000n;
}

export type SwapPlan = {
  side: SwapSide;
  amountIn: bigint;
  /** The quoter's amount out, and the least the swap accepts after slippage. */
  quote: bigint;
  amountOutMin: bigint;
  zeroForOne: boolean;
  tokenIn: Address;
  tokenOut: Address;
  /** Token → Permit2 approval when short, Permit2 → Universal Router allowance when short or expiring, then the swap. */
  steps: Step[];
};

/**
 * Quote a swap and build the tx-stepper steps for it. Buying spends USDC for shards, selling spends shards for USDC.
 * The approvals come first whenever they are missing, so a seller whose Permit2 allowance lapsed (or was never set)
 * approves instead of hitting an opaque revert. Each approval re-checks on retry and is skipped once it went through.
 */
export async function buildSwapSteps(
  p: { side: SwapSide; amountIn: bigint; key: PoolKey; account: Address; slippageBps?: number },
  chain: MarketChain,
): Promise<SwapPlan> {
  if (p.amountIn <= 0n) throw new Error("Enter an amount above zero.");
  const a = chain.addresses;
  const now = chain.now ?? (() => Math.floor(Date.now() / 1000));
  const slippageBps = BigInt(p.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  const shardIsCurrency0 = lc(p.key.currency0) !== lc(a.usdc);
  const zeroForOne = isZeroForOne(p.side, shardIsCurrency0);
  const tokenIn = zeroForOne ? p.key.currency0 : p.key.currency1;
  const tokenOut = zeroForOne ? p.key.currency1 : p.key.currency0;
  const buying = p.side === "buy";

  const tokenShort = async () => (await chain.read<bigint>({ address: tokenIn, abi: abi.erc20, functionName: "allowance", args: [p.account, a.permit2] })) < p.amountIn;
  const permitShort = async () => {
    const [amount, expiration] = await chain.read<readonly [bigint, number, number]>({ address: a.permit2, abi: abi.permit2, functionName: "allowance", args: [p.account, tokenIn, a.universalRouter] });
    return amount < p.amountIn || Number(expiration) <= now() + PERMIT2_MARGIN_SEC;
  };

  const [quote, needToken, needPermit] = await Promise.all([quoteExactIn({ key: p.key, zeroForOne, amountIn: p.amountIn, account: p.account }, chain), tokenShort(), permitShort()]);
  const amountOutMin = (quote * (10_000n - slippageBps)) / 10_000n;
  const what = buying ? "USDC" : "shards";

  const steps: Step[] = [];
  if (needToken) {
    steps.push({
      id: "approve-token",
      label: `Approve ${what} for Permit2 (once)`,
      skip: async () => !(await tokenShort()),
      run: () => chain.send({ to: tokenIn, abi: abi.erc20, functionName: "approve", args: [a.permit2, maxUint256] }),
    });
  }
  if (needPermit) {
    steps.push({
      id: "permit2",
      label: `Allow the Uniswap router to spend your ${what}`,
      skip: async () => !(await permitShort()),
      run: () => chain.send({ to: a.permit2, abi: abi.permit2, functionName: "approve", args: [tokenIn, a.universalRouter, maxUint160, now() + PERMIT2_TTL_SEC] }),
    });
  }
  steps.push({
    id: "swap",
    label: buying
      ? `Buy at least ${shardsFixed(amountOutMin, 3)} shards for ${money(p.amountIn)}`
      : `Sell ${shardsFixed(p.amountIn, 3)} shards for at least ${money(amountOutMin)}`,
    run: () => {
      const { commands, inputs } = encodeExactInSingleSwap({ key: p.key, zeroForOne, amountIn: p.amountIn, amountOutMin });
      return chain.send({ to: a.universalRouter, abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, BigInt(now() + DEADLINE_SEC)] });
    },
  });
  return { side: p.side, amountIn: p.amountIn, quote, amountOutMin, zeroForOne, tokenIn, tokenOut, steps };
}

/** A swap revert in the trader's words, by decoded error name; null for anything else. */
export function swapRevertMessage(name: string | null | undefined): { title: string; body: string } | null {
  switch (name) {
    case "V4TooLittleReceived":
      return { title: "The price moved", body: "The pool would have paid less than your minimum. Nothing was traded. Get a fresh quote and try again." };
    case "Frozen":
      return { title: "Trading is closed", body: "The card was bought out, so the pool no longer takes swaps. Nothing was traded." };
    case "TransactionDeadlinePassed":
      return { title: "The quote expired", body: "The swap waited too long to be mined. Nothing was traded. Try again." };
    default:
      return null;
  }
}

const abs = (x: bigint) => (x < 0n ? -x : x);

/**
 * The trade a swap receipt made on this card's pool, from ShardMarket's ShardSwap (only logs ShardMarket emitted).
 * Null when the receipt has none; the success state then falls back to the quote.
 */
export function swapFromReceipt(logs: readonly Log[], cardId: bigint, market: Address): { side: SwapSide; shards: bigint; usdc: bigint } | null {
  const own = logs.filter((l) => isAddressEqual(l.address, market));
  const ev = parseEventLogs({ abi: abi.shardMarket, eventName: "ShardSwap", logs: own }).find((l) => l.args.cardId === cardId);
  if (!ev) return null;
  return { side: ev.args.shardDelta > 0n ? "buy" : "sell", shards: abs(ev.args.shardDelta), usdc: abs(ev.args.usdcDelta) };
}

/** What a `collectFees` receipt paid the LP owner, from FeesCollected. Null when the receipt has none. */
export function feesFromReceipt(logs: readonly Log[], cardId: bigint, market: Address): { shards: bigint; usdc: bigint } | null {
  const own = logs.filter((l) => isAddressEqual(l.address, market));
  const ev = parseEventLogs({ abi: abi.shardMarket, eventName: "FeesCollected", logs: own }).find((l) => l.args.cardId === cardId);
  return ev ? { shards: ev.args.shardAmount, usdc: ev.args.usdcAmount } : null;
}
