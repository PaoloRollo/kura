// Uniswap v4 helpers for the Kura shard market: pool keys, pool ids, price conversion and Universal Router swaps.
//
// Encoding source: Uniswap v4-periphery `src/libraries/Actions.sol` and `src/interfaces/IV4Router.sol` at
// 2827167f8b (2024-12-10), unchanged through 3779387e5d, and universal-router `contracts/libraries/Commands.sol`
// (V4_SWAP = 0x10). NOTE: v4-periphery main since 03b2d0939b (2026-03) adds `minHopPriceX36` to
// ExactInputSingleParams; the Sepolia Universal Router (0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b) does NOT have it.
// Verified 2026-09-26 by eth_call against Sepolia: this exact encoding swapped on the ETH/USDC 1% pool, and the V4
// Quoter's amountOut as amountOutMinimum passed while quote + 1 reverted V4TooLittleReceived(quote + 1, quote).
import { encodeAbiParameters, encodePacked, keccak256, maxUint128, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** Kura pools: 1% fee, tick spacing 200, ShardMarket as the hook. */
export const KURA_POOL_FEE = 10000;
export const KURA_TICK_SPACING = 200;

/** Universal Router command byte for a v4 swap. */
export const V4_SWAP_COMMAND = 0x10;
/** V4Router action bytes used by encodeExactInSingleSwap. */
export const V4_ACTIONS = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const;

const Q192 = 2n ** 192n;
const SHARD = 10n ** 18n;

/** Sorts a shard token against USDC the way v4 does (numerically by address). */
export function sortCurrencies(shard: Address, usdc: Address): { currency0: Address; currency1: Address; shardIsCurrency0: boolean } {
  const shardIsCurrency0 = BigInt(shard) < BigInt(usdc);
  return shardIsCurrency0 ? { currency0: shard, currency1: usdc, shardIsCurrency0 } : { currency0: usdc, currency1: shard, shardIsCurrency0 };
}

/**
 * USDC raw units (6 dp) per whole shard (1e18 raw) at a pool's sqrtPriceX96. Floors. 0 for an uninitialised pool.
 * v4 price is token1 per token0 in raw units: sqrtPriceX96^2 / 2^192.
 */
export function usdcPerShardFromSqrtPrice(sqrtPriceX96: bigint, shardIsCurrency0: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  return shardIsCurrency0 ? (p2 * SHARD) / Q192 : (Q192 * SHARD) / p2;
}

/** Swap direction: buying shards spends USDC, selling spends shards. */
export function isZeroForOne(side: "buy" | "sell", shardIsCurrency0: boolean): boolean {
  // zeroForOne means currency0 goes in. Selling puts the shard in; buying puts USDC in.
  return side === "sell" ? shardIsCurrency0 : !shardIsCurrency0;
}

const POOL_KEY_PARAMS = parseAbiParameters("address,address,uint24,int24,address");

/** PoolId = keccak256(abi.encode(PoolKey)). */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters(POOL_KEY_PARAMS, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}

const EXACT_IN_SINGLE_PARAMS = parseAbiParameters(
  "((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)",
);
const CURRENCY_AMOUNT = parseAbiParameters("address,uint256");

/**
 * Universal Router `execute` arguments for an exact-in single-pool v4 swap: V4_SWAP with
 * SWAP_EXACT_IN_SINGLE, SETTLE_ALL(currencyIn, amountIn), TAKE_ALL(currencyOut, amountOutMin).
 * The caller needs an ERC20 approval to Permit2 and a Permit2 allowance for the Universal Router on currencyIn.
 */
export function encodeExactInSingleSwap(p: { key: PoolKey; zeroForOne: boolean; amountIn: bigint; amountOutMin: bigint }): { commands: Hex; inputs: Hex[] } {
  if (p.amountIn < 0n || p.amountIn > maxUint128 || p.amountOutMin < 0n || p.amountOutMin > maxUint128) throw new Error("amount out of uint128 range");
  const currencyIn = p.zeroForOne ? p.key.currency0 : p.key.currency1;
  const currencyOut = p.zeroForOne ? p.key.currency1 : p.key.currency0;
  const actions = encodePacked(["uint8", "uint8", "uint8"], [V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL]);
  const params: Hex[] = [
    encodeAbiParameters(EXACT_IN_SINGLE_PARAMS, [{ poolKey: p.key, zeroForOne: p.zeroForOne, amountIn: p.amountIn, amountOutMinimum: p.amountOutMin, hookData: "0x" }]),
    encodeAbiParameters(CURRENCY_AMOUNT, [currencyIn, p.amountIn]),
    encodeAbiParameters(CURRENCY_AMOUNT, [currencyOut, p.amountOutMin]),
  ];
  return {
    commands: encodePacked(["uint8"], [V4_SWAP_COMMAND]),
    inputs: [encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [actions, params])],
  };
}

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

/** V4 Quoter. Its quote functions are non-view (they revert internally); call them with simulateContract. */
export const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
  "function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn, uint256 gasEstimate)",
]);

export const universalRouterAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error TransactionDeadlinePassed()",
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
]);

export const permit2AllowanceAbi = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
