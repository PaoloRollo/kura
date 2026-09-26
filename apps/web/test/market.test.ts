import { describe, expect, it, vi } from "vitest";
import { parseUsdcInput } from "@/lib/shard-math";
import { parseShardAmount } from "@/components/send-shards";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, maxUint160, parseAbiParameters as pap, type Log, parseAbiParameters, type Address } from "viem";
import { abi, universalRouterAbi } from "@kura/shared";
import {
  buildSwapSteps,
  feesFromReceipt,
  impliedCardValue,
  livePrice,
  loadPool,
  maxAmountText,
  loadSwaps,
  marketPrice,
  pctDelta,
  poolKeyOf,
  swapFromReceipt,
  swapSeries,
  type MarketChain,
  type PoolRow,
  type SwapRow,
} from "@/lib/market";
import type { SendInput, Sent } from "@/lib/tx-core";

const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
// One shard token below USDC (shard is currency0) and one above (shard is currency1).
const LOW = "0x0a00000000000000000000000000000000000001" as Address;
const HIGH = "0xf000000000000000000000000000000000000001" as Address;
const HOOK = "0x5555555555555555555555555555555555550ac0" as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const ROUTER = "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b" as Address;
const QUOTER = "0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227" as Address;
const STATE_VIEW = "0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C" as Address;
const ME = "0x00000000000000000000000000000000000000Aa" as Address;
const NOW = 1_790_000_000;
const SHARD = 10n ** 18n;
const ADDRS = { usdc: USDC, permit2: PERMIT2, universalRouter: ROUTER, v4Quoter: QUOTER, stateView: STATE_VIEW, shardMarket: HOOK };

function pool(shardToken: Address, over: Partial<PoolRow> = {}): PoolRow {
  return {
    cardId: 1n, poolId: "0x01", shardToken, shardIsCurrency0: BigInt(shardToken) < BigInt(USDC), sqrtPriceX96: 0n, priceUsdcPerShard: 10_000_000n,
    seededAt: 1n, seedShards: 8n * SHARD, seedUsdc: 80_000_000n, lastSwapAt: null, swapCount: 0, volumeUsdc: 0n, frozen: false,
    lpOwner: ME, feesShards: 0n, feesUsdc: 0n, ...over,
  } as PoolRow;
}

type Allowances = { erc20: bigint; permit2: bigint; expiration: number };

/** A chain with the given allowances: the quoter answers `quote`, every send is recorded. */
function chain(a: Allowances, quote = 1_000_000n) {
  const sent: SendInput[] = [];
  const simulate = vi.fn(async (_req: { args: readonly unknown[] }) => ({ result: [quote, 100_000n] as const }));
  const c: MarketChain = {
    read: vi.fn(async (req: { address: string; functionName: string }) => {
      if (req.functionName === "allowance" && req.address === PERMIT2) return [a.permit2, a.expiration, 0];
      if (req.functionName === "allowance") return a.erc20;
      throw new Error(`unexpected read ${req.functionName}`);
    }) as MarketChain["read"],
    simulate: simulate as unknown as MarketChain["simulate"],
    send: vi.fn(async (input: SendInput): Promise<Sent> => {
      sent.push(input);
      return { hash: "0xabc", receipt: {} as Sent["receipt"] };
    }),
    now: () => NOW,
    addresses: ADDRS,
  };
  return { c, sent, simulate };
}

const decodeSwap = (input: SendInput) => {
  const { args } = decodeFunctionData({ abi: universalRouterAbi, data: encodeExecute(input) });
  const [, inputs, deadline] = args as readonly [string, readonly `0x${string}`[], bigint];
  const [, params] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), inputs[0]);
  const [swap] = decodeAbiParameters(
    parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)"),
    params[0],
  );
  return { swap, deadline };
};

const encodeExecute = (input: SendInput) => encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: input.args as never });

describe("poolKeyOf", () => {
  it("sorts the currencies and uses the Kura fee, spacing and hook", () => {
    expect(poolKeyOf(pool(LOW), ADDRS)).toEqual({ currency0: LOW, currency1: USDC, fee: 10000, tickSpacing: 200, hooks: HOOK });
    expect(poolKeyOf(pool(HIGH), ADDRS)).toEqual({ currency0: USDC, currency1: HIGH, fee: 10000, tickSpacing: 200, hooks: HOOK });
  });
});

describe("buildSwapSteps", () => {
  const full: Allowances = { erc20: 2n ** 255n, permit2: maxUint160, expiration: NOW + 30 * 86_400 };

  it("asks for both approvals first when nothing is approved", async () => {
    const { c, sent } = chain({ erc20: 0n, permit2: 0n, expiration: 0 });
    const plan = await buildSwapSteps({ side: "buy", amountIn: 50_000_000n, key: poolKeyOf(pool(LOW), ADDRS), account: ME }, c);
    expect(plan.steps.map((s) => s.id)).toEqual(["approve-token", "permit2", "swap"]);
    for (const s of plan.steps) await s.run();
    expect(sent[0]).toMatchObject({ to: USDC, abi: abi.erc20, functionName: "approve", args: [PERMIT2, 2n ** 256n - 1n] });
    expect(sent[1]).toMatchObject({ to: PERMIT2, functionName: "approve" });
    expect(sent[1].args!.slice(0, 3)).toEqual([USDC, ROUTER, maxUint160]);
    expect(Number(sent[1].args![3])).toBeGreaterThan(NOW + 86_400);
    expect(sent[2]).toMatchObject({ to: ROUTER, functionName: "execute" });
  });

  it("renews a Permit2 allowance that expired (or is about to), even when the amount is enough", async () => {
    const { c } = chain({ erc20: 2n ** 255n, permit2: maxUint160, expiration: NOW - 1 });
    const plan = await buildSwapSteps({ side: "sell", amountIn: 3n * SHARD, key: poolKeyOf(pool(HIGH), ADDRS), account: ME }, c);
    expect(plan.steps.map((s) => s.id)).toEqual(["permit2", "swap"]);
    const soon = chain({ erc20: 2n ** 255n, permit2: maxUint160, expiration: NOW + 60 });
    expect((await buildSwapSteps({ side: "sell", amountIn: 3n * SHARD, key: poolKeyOf(pool(HIGH), ADDRS), account: ME }, soon.c)).steps.map((s) => s.id)).toEqual(["permit2", "swap"]);
  });

  it("asks for Permit2 when its allowance is short", async () => {
    const { c } = chain({ erc20: 2n ** 255n, permit2: 1n, expiration: NOW + 86_400 });
    expect((await buildSwapSteps({ side: "buy", amountIn: 5_000_000n, key: poolKeyOf(pool(LOW), ADDRS), account: ME }, c)).steps.map((s) => s.id)).toEqual(["permit2", "swap"]);
  });

  it("goes straight to the swap with full allowances, with 1% slippage off the quote by default", async () => {
    const { c, sent } = chain(full, 2_000_000n);
    const plan = await buildSwapSteps({ side: "buy", amountIn: 20_000_000n, key: poolKeyOf(pool(LOW), ADDRS), account: ME }, c);
    expect(plan.steps.map((s) => s.id)).toEqual(["swap"]);
    expect(plan.quote).toBe(2_000_000n);
    expect(plan.amountOutMin).toBe(1_980_000n);
    await plan.steps[0].run();
    const { swap, deadline } = decodeSwap(sent[0]);
    expect(swap.amountIn).toBe(20_000_000n);
    expect(swap.amountOutMinimum).toBe(1_980_000n);
    expect(deadline).toBeGreaterThan(BigInt(NOW));
    const custom = await buildSwapSteps({ side: "buy", amountIn: 20_000_000n, key: poolKeyOf(pool(LOW), ADDRS), account: ME, slippageBps: 50 }, c);
    expect(custom.amountOutMin).toBe(1_990_000n);
  });

  it("skips an approval step on retry once it went through", async () => {
    const a: Allowances = { erc20: 0n, permit2: 0n, expiration: 0 };
    const { c } = chain(a);
    const plan = await buildSwapSteps({ side: "buy", amountIn: 1_000_000n, key: poolKeyOf(pool(LOW), ADDRS), account: ME }, c);
    a.erc20 = 2n ** 255n;
    a.permit2 = maxUint160;
    a.expiration = NOW + 86_400 * 30;
    expect(await plan.steps[0].skip!()).toBe(true);
    expect(await plan.steps[1].skip!()).toBe(true);
  });

  // Buying spends USDC, selling spends shards; zeroForOne is whether currency0 goes in.
  for (const [name, token, side, zeroForOne, tokenIn] of [
    ["buy, shard is currency0", LOW, "buy", false, USDC],
    ["sell, shard is currency0", LOW, "sell", true, LOW],
    ["buy, shard is currency1", HIGH, "buy", true, USDC],
    ["sell, shard is currency1", HIGH, "sell", false, HIGH],
  ] as const) {
    it(`sets zeroForOne and the input token: ${name}`, async () => {
      const { c, sent, simulate } = chain({ erc20: 0n, permit2: 0n, expiration: 0 });
      const plan = await buildSwapSteps({ side, amountIn: 1_000_000n, key: poolKeyOf(pool(token), ADDRS), account: ME }, c);
      expect(plan.zeroForOne).toBe(zeroForOne);
      expect(plan.tokenIn).toBe(tokenIn);
      expect((simulate.mock.calls[0][0].args[0] as { zeroForOne: boolean }).zeroForOne).toBe(zeroForOne);
      for (const s of plan.steps) await s.run();
      expect(sent[0].to).toBe(tokenIn);
      expect(sent[1].args![0]).toBe(tokenIn);
      expect(decodeSwap(sent[2]).swap.zeroForOne).toBe(zeroForOne);
    });
  }

  it("refuses an empty amount", async () => {
    const { c } = chain(full);
    await expect(buildSwapSteps({ side: "buy", amountIn: 0n, key: poolKeyOf(pool(LOW), ADDRS), account: ME }, c)).rejects.toThrow();
  });
});

describe("prices", () => {
  it("has no price without a pool, and none for an empty one", async () => {
    const read = vi.fn();
    expect(await livePrice(null, { read, addresses: ADDRS })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(marketPrice(null, null)).toBeNull();
    expect(marketPrice(pool(LOW, { priceUsdcPerShard: 0n }), null)).toBeNull();
  });

  it("reads the live price from StateView in both token orders", async () => {
    // $10 per whole shard: 1e7 raw USDC per 1e18 raw shards.
    const q96 = 2n ** 96n;
    const sqrtLow = sqrt((10_000_000n * q96 * q96) / SHARD); // usdc/shard
    const sqrtHigh = sqrt((SHARD * q96 * q96) / 10_000_000n); // shard/usdc
    for (const [token, sq] of [[LOW, sqrtLow], [HIGH, sqrtHigh]] as const) {
      const read = vi.fn(async (req: { address: string; functionName: string; args: readonly unknown[] }) => {
        expect(req.address).toBe(STATE_VIEW);
        expect(req.functionName).toBe("getSlot0");
        expect(req.args[0]).toBe("0x01");
        return [sq, 0, 0, 10000];
      });
      const p = await livePrice(pool(token), { read: read as never, addresses: ADDRS });
      expect(Number(p!.priceUsdcPerShard)).toBeCloseTo(10_000_000, -1);
    }
  });

  it("prefers the live price, else the indexer's, and values the card at price × shards", () => {
    expect(marketPrice(pool(LOW), 12_000_000n)).toBe(12_000_000n);
    expect(marketPrice(pool(LOW), null)).toBe(10_000_000n);
    expect(impliedCardValue(12_000_000n, 32)).toBe(384_000_000n);
    expect(impliedCardValue(null, 32)).toBeNull();
    expect(pctDelta(110n, 100n)).toBeCloseTo(10);
    expect(pctDelta(90n, 100n)).toBeCloseTo(-10);
    expect(pctDelta(90n, 0n)).toBeNull();
    expect(pctDelta(90n, null)).toBeNull();
  });
});

describe("indexer reads", () => {
  /** A drizzle-like builder that records the chain and resolves to `rows`. */
  function fakeDb(rows: unknown[]) {
    const calls: string[] = [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "from", "where", "orderBy", "limit"]) q[m] = (...a: unknown[]) => { calls.push(m + (m === "limit" ? `:${a[0]}` : "")); return q; };
    q.then = (res: (v: unknown) => void) => res(rows);
    return { db: q as never, calls };
  }

  // usePonderQuery needs the unexecuted query builder (it compiles it to SQL and subscribes to live updates):
  // an awaited or wrapped Promise fails at runtime with '"queryFn" must return SQL'.
  it("builds the card's pool query without executing it: at most one row", async () => {
    const one = fakeDb([pool(LOW)]);
    const q = loadPool(one.db, 1n);
    expect(q).toBe(one.db);
    expect(one.calls).toContain("limit:1");
    expect((await q)[0]?.shardToken).toBe(LOW);
    expect(await loadPool(fakeDb([]).db, 1n)).toEqual([]);
  });

  it("builds the latest-swaps query without executing it, up to the limit", async () => {
    const f = fakeDb([{ id: "a" }]);
    const q = loadSwaps(f.db, 1n, 50);
    expect(q).toBe(f.db);
    expect(await q).toEqual([{ id: "a" }]);
    expect(f.calls).toContain("limit:50");
  });
});

describe("swapSeries", () => {
  it("charts the pool price after each swap, oldest first, in dollars per shard", () => {
    const s = (id: string, ts: number, sqrt: bigint, price: bigint) => ({ id, cardId: 1n, trader: ME, side: "buy", shardAmount: SHARD, usdcAmount: price, priceUsdcPerShard: price, sqrtPriceX96: sqrt, blockNumber: BigInt(ts), timestamp: BigInt(ts), txHash: "0x" }) as SwapRow;
    const pts = swapSeries([s("b", 200, 0n, 12_000_000n), s("a", 100, 0n, 11_000_000n)], pool(LOW, { seededAt: 50n, priceUsdcPerShard: 10_000_000n }), 10_000_000n);
    expect(pts).toEqual([{ t: 50, usd: 10 }, { t: 100, usd: 11 }, { t: 200, usd: 12 }]);
    expect(swapSeries([], null, null)).toEqual([]);
  });
});

function sqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

describe("receipts", () => {
  const log = (address: Address, eventName: "ShardSwap" | "FeesCollected", args: Record<string, unknown>, data: `0x${string}`): Log =>
    ({ address, topics: encodeEventTopics({ abi: abi.shardMarket, eventName, args } as never), data, blockNumber: 1n, logIndex: 0, transactionHash: "0x", transactionIndex: 0, blockHash: "0x", removed: false }) as unknown as Log;
  const swap = (cardId: bigint, shardDelta: bigint, usdcDelta: bigint, from = HOOK) =>
    log(from, "ShardSwap", { cardId, poolId: `0x${"11".repeat(32)}` }, encodeAbiParameters(pap("int256,int256,uint160"), [shardDelta, usdcDelta, 1n]));

  it("reads the trade from ShardSwap, only from the market and for this card", () => {
    expect(swapFromReceipt([swap(1n, 3n * SHARD, -30_000_000n)], 1n, HOOK)).toEqual({ side: "buy", shards: 3n * SHARD, usdc: 30_000_000n });
    expect(swapFromReceipt([swap(1n, -SHARD, 9_000_000n)], 1n, HOOK)).toEqual({ side: "sell", shards: SHARD, usdc: 9_000_000n });
    expect(swapFromReceipt([swap(2n, SHARD, -1n)], 1n, HOOK)).toBeNull();
    expect(swapFromReceipt([swap(1n, SHARD, -1n, USDC)], 1n, HOOK)).toBeNull();
  });

  it("reads the fees an LP owner collected", () => {
    const l = log(HOOK, "FeesCollected", { cardId: 1n, lpOwner: ME.toLowerCase() }, encodeAbiParameters(pap("uint256,uint256"), [SHARD / 10n, 420_000n]));
    expect(feesFromReceipt([l], 1n, HOOK)).toEqual({ shards: SHARD / 10n, usdc: 420_000n });
    expect(feesFromReceipt([], 1n, HOOK)).toBeNull();
  });
});

describe("maxAmountText", () => {
  it("fills the whole USDC balance on a buy, exactly, and it parses back to the balance", () => {
    expect(maxAmountText("buy", 10_000_000_000n)).toBe("10000");
    expect(maxAmountText("buy", 1_234_567n)).toBe("1.234567");
    expect(parseUsdcInput(maxAmountText("buy", 1_234_567n)!)).toBe(1_234_567n);
  });

  it("fills the whole shard balance on a sell to the last wei, so nothing is left behind", () => {
    expect(maxAmountText("sell", 3n * 10n ** 18n)).toBe("3");
    const odd = 7_200_000_000_000_000_001n;
    expect(maxAmountText("sell", odd)).toBe("7.200000000000000001");
    expect(parseShardAmount(maxAmountText("sell", odd)!)).toBe(odd);
  });

  it("offers no max without a balance", () => {
    expect(maxAmountText("buy", null)).toBeNull();
    expect(maxAmountText("sell", 0n)).toBeNull();
  });
});
