import { describe, expect, it } from "vitest";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAbiItem,
  keccak256,
  parseAbiParameters,
  toFunctionSelector,
  type Address,
} from "viem";
import {
  KURA_POOL_FEE,
  KURA_TICK_SPACING,
  V4_ACTIONS,
  V4_SWAP_COMMAND,
  encodeExactInSingleSwap,
  isZeroForOne,
  permit2AllowanceAbi,
  poolIdOf,
  sortCurrencies,
  stateViewAbi,
  universalRouterAbi,
  usdcPerShardFromSqrtPrice,
  v4QuoterAbi,
  type PoolKey,
} from "../src/v4";

const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const LOW = "0x0000000000000000000000000000000000001234" as Address; // sorts below USDC
const HIGH = "0xfFFfFfFffFFfFFFffFFffffFfFFfFfFfffff0001" as Address; // sorts above USDC
const HOOK = "0x00000000000000000000000000000000000020C0" as Address;

const Q96 = 2n ** 96n;
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
// Task A2's formula: clearingPriceQ96 is USDC raw units per shard raw unit, Q96.
function sqrtPriceFromClearing(clearingQ96: bigint, shardIsCurrency0: boolean): bigint {
  return shardIsCurrency0 ? isqrt(clearingQ96 << 96n) : isqrt((2n ** 192n * Q96) / clearingQ96);
}
const within = (got: bigint, want: bigint, bps: bigint) => {
  const diff = got > want ? got - want : want - got;
  return diff * 10_000n <= want * bps;
};

describe("sortCurrencies", () => {
  it("puts a shard below USDC first", () => {
    expect(sortCurrencies(LOW, USDC)).toEqual({ currency0: LOW, currency1: USDC, shardIsCurrency0: true });
  });
  it("puts a shard above USDC second", () => {
    expect(sortCurrencies(HIGH, USDC)).toEqual({ currency0: USDC, currency1: HIGH, shardIsCurrency0: false });
  });
  it("compares case-insensitively", () => {
    expect(sortCurrencies(HIGH.toLowerCase() as Address, USDC).shardIsCurrency0).toBe(false);
    expect(sortCurrencies(LOW, USDC.toLowerCase() as Address).shardIsCurrency0).toBe(true);
  });
});

describe("usdcPerShardFromSqrtPrice", () => {
  const tenDollars = 10_000_000n; // 6 dp
  const clearingQ96 = (tenDollars * Q96) / 10n ** 18n;
  it("reads $10/shard when the shard is currency0", () => {
    const got = usdcPerShardFromSqrtPrice(sqrtPriceFromClearing(clearingQ96, true), true);
    expect(within(got, tenDollars, 1n)).toBe(true);
  });
  it("reads $10/shard when the shard is currency1", () => {
    const got = usdcPerShardFromSqrtPrice(sqrtPriceFromClearing(clearingQ96, false), false);
    expect(within(got, tenDollars, 1n)).toBe(true);
  });
  it("handles extreme prices in both orders", () => {
    for (const usdc of [1n, 1_000_000_000_000n]) { // $0.000001 and $1,000,000
      const q = (usdc * Q96) / 10n ** 18n + 1n;
      for (const s0 of [true, false]) {
        expect(within(usdcPerShardFromSqrtPrice(sqrtPriceFromClearing(q, s0), s0), usdc, 100n), `${usdc} ${s0}`).toBe(true);
      }
    }
  });
  it("returns 0 for an uninitialised pool", () => {
    expect(usdcPerShardFromSqrtPrice(0n, true)).toBe(0n);
    expect(usdcPerShardFromSqrtPrice(0n, false)).toBe(0n);
  });
});

describe("poolIdOf", () => {
  it("matches a real Sepolia pool id (ETH/USDC 1%, emitted by PoolManager.Initialize)", () => {
    const key: PoolKey = { currency0: "0x0000000000000000000000000000000000000000", currency1: USDC, fee: 10000, tickSpacing: 200, hooks: "0x0000000000000000000000000000000000000000" };
    expect(poolIdOf(key)).toBe("0x8439998c1a5d4ec8c7ec9b02eb25f5f41e3eb2d41eb2bef710778a38ec12eb9d");
  });
  it("equals keccak256(abi.encode(key)) computed independently", () => {
    const key: PoolKey = { currency0: USDC, currency1: HIGH, fee: KURA_POOL_FEE, tickSpacing: KURA_TICK_SPACING, hooks: HOOK };
    const want = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [USDC, HIGH, 10000, 200, HOOK]));
    expect(poolIdOf(key)).toBe(want);
  });
});

describe("isZeroForOne", () => {
  it("buying shards spends USDC; selling spends shards, in both orders", () => {
    expect(isZeroForOne("buy", true)).toBe(false); // USDC is currency1 -> 1 for 0
    expect(isZeroForOne("sell", true)).toBe(true);
    expect(isZeroForOne("buy", false)).toBe(true); // USDC is currency0
    expect(isZeroForOne("sell", false)).toBe(false);
  });
});

describe("encodeExactInSingleSwap", () => {
  const key: PoolKey = { currency0: USDC, currency1: HIGH, fee: 10000, tickSpacing: 200, hooks: HOOK };
  const PK = "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";

  it.each([true, false])("encodes V4_SWAP with SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL (zeroForOne=%s)", (zeroForOne) => {
    const { commands, inputs } = encodeExactInSingleSwap({ key, zeroForOne, amountIn: 123_456n, amountOutMin: 7n * 10n ** 17n });
    expect(commands).toBe("0x10");
    expect(inputs).toHaveLength(1);
    const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), inputs[0]!);
    expect(actions).toBe("0x060c0f");
    expect(params).toHaveLength(3);

    const [swap] = decodeAbiParameters(
      parseAbiParameters(`(${PK} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`),
      params[0]!,
    );
    expect(swap.poolKey.currency0).toBe(USDC);
    expect(swap.poolKey.currency1).toBe(HIGH);
    expect(swap.poolKey.fee).toBe(10000);
    expect(swap.poolKey.tickSpacing).toBe(200);
    expect(swap.poolKey.hooks).toBe(HOOK);
    expect(swap.zeroForOne).toBe(zeroForOne);
    expect(swap.amountIn).toBe(123_456n);
    expect(swap.amountOutMinimum).toBe(7n * 10n ** 17n);
    expect(swap.hookData).toBe("0x");

    const [inCur, inAmt] = decodeAbiParameters(parseAbiParameters("address,uint256"), params[1]!);
    const [outCur, outAmt] = decodeAbiParameters(parseAbiParameters("address,uint256"), params[2]!);
    expect(inCur).toBe(zeroForOne ? USDC : HIGH);
    expect(inAmt).toBe(123_456n);
    expect(outCur).toBe(zeroForOne ? HIGH : USDC);
    expect(outAmt).toBe(7n * 10n ** 17n);
  });

  it("rejects amounts that do not fit uint128", () => {
    expect(() => encodeExactInSingleSwap({ key, zeroForOne: true, amountIn: 2n ** 128n, amountOutMin: 0n })).toThrow();
  });

  it("exposes the verified byte values", () => {
    expect(V4_SWAP_COMMAND).toBe(0x10);
    expect(V4_ACTIONS).toEqual({ SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f });
  });
});

describe("ABIs", () => {
  it("have the deployed selectors", () => {
    expect(toFunctionSelector(getAbiItem({ abi: stateViewAbi, name: "getSlot0" })!)).toBe(toFunctionSelector("getSlot0(bytes32)"));
    expect(toFunctionSelector(getAbiItem({ abi: stateViewAbi, name: "getLiquidity" })!)).toBe(toFunctionSelector("getLiquidity(bytes32)"));
    expect(toFunctionSelector(getAbiItem({ abi: v4QuoterAbi, name: "quoteExactInputSingle" })!)).toBe(
      toFunctionSelector("quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))"),
    );
    expect(toFunctionSelector(getAbiItem({ abi: v4QuoterAbi, name: "quoteExactOutputSingle" })!)).toBe(
      toFunctionSelector("quoteExactOutputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))"),
    );
    expect(toFunctionSelector(getAbiItem({ abi: universalRouterAbi, name: "execute" })!)).toBe(toFunctionSelector("execute(bytes,bytes[],uint256)"));
    expect(toFunctionSelector(getAbiItem({ abi: permit2AllowanceAbi, name: "approve" })!)).toBe("0x87517c45");
    expect(toFunctionSelector(getAbiItem({ abi: permit2AllowanceAbi, name: "allowance" })!)).toBe(toFunctionSelector("allowance(address,address,address)"));
  });
});
