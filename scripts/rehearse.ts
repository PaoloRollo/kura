// Demo rehearsal and seeding. Drives five real cards through every path of the vault and its shard market (a buyout
// through the card's Uniswap v4 pool, a graduated auction whose pool is traded, reserve not met, physical release,
// whole) with synthetic `seed…` wallets, printing each tx and asserting the result.
//
//   pnpm rehearse                 print the plan (wallets, cards, amounts, USDC and ETH budget) and exit
//   pnpm rehearse --dry-run       run the whole scenario on a local anvil fork of Sepolia; nothing is broadcast
//   pnpm rehearse --broadcast     run it on Sepolia (asks you to type BROADCAST; refuses without a TTY or in CI)
//   --live-blocks N               duration of the re-sharded live auction (default 7200 blocks, about a day)
//   --fork-url URL                dry run only: fork this RPC instead (e.g. a local anvil with a fresh Deploy.s.sol)
//   --deployments PATH            dry run only: read the addresses from PATH instead of contracts/deployments/sepolia.json
//
// Broadcast runs are resumable: scripts/.rehearse-state.sepolia.<cardVault>.json records every step and its tx hash. A
// rerun skips finished steps, and a step with a hash but no receipt is waited for, never sent again. The file is keyed by
// the vault, so a redeploy starts afresh (the old file is simply ignored; delete it when done).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  WaitForTransactionReceiptTimeoutError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  parseTransaction,
  formatEther,
  formatUnits,
  http,
  keccak256,
  maxUint160,
  maxUint256,
  maxUint48,
  parseEther,
  parseEventLogs,
  toFunctionSelector,
  toHex,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { generateMnemonic, english, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  APPRAISAL_TYPES,
  DeploymentsSchema,
  TICKET_TYPES,
  TicketKind,
  abi,
  bidGateDomain,
  cardVaultDomain,
  encodeExactInSingleSwap,
  isZeroForOne,
  poolIdOf,
  sortCurrencies,
  universalRouterAbi,
  usdcPerShardFromSqrtPrice,
  KURA_POOL_FEE,
  KURA_TICK_SPACING,
  v4QuoterAbi,
  permit2AllowanceAbi,
  stateViewAbi,
  q96ToUsdcPerShard,
  setCode,
  slugify,
  usdcPerShardToQ96,
  type Deployments,
  type PoolKey,
  type Ticket,
} from "@kura/shared";
import { exitRoute, type ExitCheckpoint } from "../apps/web/src/lib/bid-math";
import { finishOf, marketPerShard, quoteMarketPrice, quoteUsdc, type PrintingPrices } from "../apps/web/src/lib/pricing";
import { encodeHookData } from "../apps/web/src/lib/tx-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHARD = 10n ** 18n;
const USDC = 10n ** 6n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// ---------------------------------------------------------------------------------------------------------------------
// Scenario (pure)

export type CardKey = "A" | "B" | "C" | "D" | "E";
export type Role = "owner0" | "owner1" | "bidder0" | "bidder1" | "bidder2" | "bidder3";
export const ROLES: readonly Role[] = ["owner0", "owner1", "bidder0", "bidder1", "bidder2", "bidder3"];
/** Collector handles (a-z0-9 only: CardNames refuses dashes, so "seed" is a prefix, not "seed-"). */
export const HANDLES: Record<Role, string> = {
  owner0: "seedaiko", owner1: "seedkenji", bidder0: "seedmei", bidder1: "seedren", bidder2: "seedsora", bidder3: "seedyuki",
};

/** Cheap real printings (Scryfall USD in the $0.25–$3 band when chosen); every price is re-read and re-quoted live. */
export const CARDS: Record<CardKey, { scryfallId: string; owner: Role; role: string }> = {
  A: { scryfallId: "9521375e-0bc1-45ef-b513-6d332a25f9d2", owner: "owner0", role: "bought out through its pool, then re-sharded as the live auction" }, // Lightning Bolt, 4ED
  B: { scryfallId: "cca8eb95-d071-46a4-885c-3da25b401806", owner: "owner1", role: "graduated auction, stays sharded, traded on its pool" }, // Counterspell, A25
  C: { scryfallId: "5fa7af70-08d0-453f-a0b6-a408642bf03e", owner: "owner0", role: "reserve not met, all bids refunded" }, // Llanowar Elves, BTD
  D: { scryfallId: "6739a5bb-5ed7-4f15-affb-4170239d997a", owner: "owner1", role: "released at the counter (Passport ticket)" }, // Dark Ritual, SUM
  E: { scryfallId: "b635680a-12ae-49f8-a3d7-7254cb0962ec", owner: "owner0", role: "stays whole: station and owner fallback" }, // Swords to Plowshares, MB2
};

export const TOTAL_SHARDS = 16;
/** CardVault auctions half the shards; the other half and the proceeds seed the card's pool. */
export const FOR_SALE = TOTAL_SHARDS / 2;
export const TICK_USDC = 10_000n; // 0.01 USDC per shard
export const MIN_FLOOR_USDC = 50_000n; // 0.05 USDC per shard
export const BID_TTL_SEC = 3600n; // HUMAN tickets: short-lived on purpose
export const PASSPORT_TTL_SEC = 900n;
export const APPRAISAL_TTL_SEC = 600n;
export const ENDED_AUCTION_BLOCKS = { A: 25, B: 30, C: 30 } as const;
export const DEFAULT_LIVE_BLOCKS = 7200;

/** A bid: `ticks` above the floor, budget = `shardsX10 / 10` shards at that max. */
export type BidPlan = { bidder: Role; ticks: number; shardsX10: number };
export type AuctionPlan = {
  floorUsdc: bigint;
  reserveUsdc: bigint;
  durationBlocks: number;
  /** In submission order: lowest max first, so each bid meets the floor as the clearing price. */
  bids: BidPlan[];
};

export const AUCTION_SHAPES: Record<"A" | "B" | "C" | "A2", Omit<AuctionPlan, "floorUsdc" | "durationBlocks">> = {
  // The buyer takes the whole sale half (8.5 shards of demand for 8: partly filled at its max, the rest refunded). That
  // is 50%; it buys the other 30% from the pool and redeems.
  A: { reserveUsdc: 0n, bids: [{ bidder: "bidder0", ticks: 1, shardsX10: 85 }] },
  // Four bidders at different maxes: demand above supply, so the clearing climbs and the lowest bid is outbid.
  B: { reserveUsdc: 0n, bids: [{ bidder: "bidder3", ticks: 1, shardsX10: 10 }, { bidder: "bidder2", ticks: 2, shardsX10: 15 }, { bidder: "bidder1", ticks: 3, shardsX10: 20 }, { bidder: "bidder0", ticks: 4, shardsX10: 30 }] },
  // Reserve far above the bids: the auction does not graduate, both bids are refunded in full and there is no pool.
  C: { reserveUsdc: 5n * USDC, bids: [{ bidder: "bidder3", ticks: 1, shardsX10: 10 }, { bidder: "bidder2", ticks: 2, shardsX10: 10 }] },
  // The live auction for the demo, with one pre-seeded bid (the fallback if World ID fails on stage).
  A2: { reserveUsdc: 0n, bids: [{ bidder: "bidder3", ticks: 2, shardsX10: 10 }] },
};

export const floorToTick = (usdc: bigint, tick: bigint) => (usdc / tick) * tick;
export const tickQ96 = (tickUsdc: bigint) => usdcPerShardToQ96(tickUsdc);
/** The auction floor in Q96, as CardVault._auctionParams builds it (an exact tick multiple). */
export const floorQ96 = (floorUsdc: bigint, tickUsdc: bigint) => tickQ96(tickUsdc) * (floorUsdc / tickUsdc);
export const bidMaxQ96 = (floorUsdc: bigint, tickUsdc: bigint, ticks: number) => floorQ96(floorUsdc, tickUsdc) + BigInt(ticks) * tickQ96(tickUsdc);
/** USDC a bid spends at most: its shards at its max price. */
export const bidBudget = (floorUsdc: bigint, tickUsdc: bigint, b: BidPlan) => (q96ToUsdcPerShard(bidMaxQ96(floorUsdc, tickUsdc, b.ticks)) * BigInt(b.shardsX10)) / 10n;

/** CardVault.shardAndAuction's ShardParams (no forSale: the vault always auctions half). */
export const shardParams = (a: AuctionPlan) => ({ totalShards: TOTAL_SHARDS, floorUsdcPerShard: a.floorUsdc, tickUsdcPerShard: TICK_USDC, reserveUsdc: a.reserveUsdc, durationBlocks: a.durationBlocks });

/** Floor per shard: the market price per shard rounded down to a tick, at least MIN_FLOOR_USDC. */
export const floorFor = (marketUsdc: bigint) => {
  const f = floorToTick(marketUsdc / BigInt(TOTAL_SHARDS), TICK_USDC);
  return f < MIN_FLOOR_USDC ? MIN_FLOOR_USDC : f;
};

export type ScenarioPlan = {
  markets: Record<CardKey, string>; // USDC units (condition-adjusted, lib/pricing), as strings for the state file
  auctions: Record<"A" | "B" | "C" | "A2", AuctionPlan>;
  liveBlocks: number;
};

export function planScenario(markets: Record<CardKey, bigint>, liveBlocks: number): ScenarioPlan {
  const auction = (key: "A" | "B" | "C" | "A2", card: CardKey, durationBlocks: number): AuctionPlan => ({ ...AUCTION_SHAPES[key], floorUsdc: floorFor(markets[card]), durationBlocks });
  return {
    markets: Object.fromEntries(Object.entries(markets).map(([k, v]) => [k, v.toString()])) as Record<CardKey, string>,
    auctions: { A: auction("A", "A", ENDED_AUCTION_BLOCKS.A), B: auction("B", "B", ENDED_AUCTION_BLOCKS.B), C: auction("C", "C", ENDED_AUCTION_BLOCKS.C), A2: auction("A2", "A", liveBlocks) },
    liveBlocks,
  };
}

// --- pool trades ---------------------------------------------------------------------------------------------------

/** Card A's buyer: wins the auction, buys the rest of its 80% from the pool, redeems and re-shards the card. */
export const BUYER: Role = "bidder0";
export const SWAP_SLIPPAGE_BPS = 100n;
export const POOL_FEE_BPS = 100n; // Kura pools: fee 10000 (1%)
/** The pool-buy estimate is a constant-product bound at the clearing price; the margin covers a smaller auction fill. */
export const BUYOUT_MARGIN_BPS = 15_000n;
/** The buyer buys at most this many shards per swap, re-quoting and re-checking its balance between chunks. */
export const BUYOUT_CHUNK = 2n * SHARD;

/** Swaps on card B's pool after it settles, for price history: `amount` is USDC in (buy) or at most that many shards (sell). */
export type TradePlan = { id: string; role: Role; side: "buy" | "sell"; amount: bigint };
export const TRADES_B: readonly TradePlan[] = [
  { id: "swap-B-1", role: "bidder3", side: "buy", amount: 100_000n },
  { id: "swap-B-2", role: "bidder2", side: "buy", amount: 50_000n },
  { id: "swap-B-3", role: "bidder1", side: "sell", amount: SHARD / 4n },
];

/** The smallest balance CardVault.redeem accepts: bal * 5 >= supply * 4. */
export const redeemTarget = (supply: bigint) => (supply * 4n + 4n) / 5n;
export const minOut = (quote: bigint, slippageBps = SWAP_SLIPPAGE_BPS) => (quote * (10_000n - slippageBps)) / 10_000n;

/** Universal Router `execute` args for an exact-in swap on a Kura pool. */
export function swapExecuteArgs(key: PoolKey, shardIsCurrency0: boolean, side: "buy" | "sell", amountIn: bigint, amountOutMin: bigint, deadline: bigint): readonly [Hex, Hex[], bigint] {
  const { commands, inputs } = encodeExactInSingleSwap({ key, zeroForOne: isZeroForOne(side, shardIsCurrency0), amountIn, amountOutMin });
  return [commands, inputs, deadline] as const;
}

/** ShardSwap deltas are the trader's: a buy pays exactly `amountIn` USDC for shards, a sell pays exactly `amountIn` shards. */
export function swapSignsOk(side: "buy" | "sell", amountIn: bigint, shardDelta: bigint, usdcDelta: bigint): boolean {
  return side === "buy" ? shardDelta > 0n && usdcDelta === -amountIn : shardDelta === -amountIn && usdcDelta > 0n;
}

export type BuyoutEstimate = { clearingUsdc: bigint; fillShards: bigint; poolShards: bigint; needShards: bigint; poolBuyUsdc: bigint; redeemUsdc: bigint };

/**
 * An upper-bound estimate of card A's buyout for the budget. The buyer's bid sets the clearing (it takes the whole sale
 * half at its max), so the pool opens at that price with the fee-reduced proceeds, funding a full-range position of
 * FOR_SALE × (1 − fee) shards. Buying the rest of 80% from it costs y·Δ/(x − Δ) plus the 1% pool fee, with a margin.
 * The redeem pays max(clearing, appraisal) for the shards the buyer doesn't hold, plus the vault fee.
 */
export function buyoutEstimate(plan: ScenarioPlan, feeBps: bigint): BuyoutEstimate {
  const A = plan.auctions.A;
  const bid = A.bids.find((b) => b.bidder === BUYER);
  if (!bid) throw new Error(`card A has no bid from the buyer ${BUYER}`);
  const clearingUsdc = q96ToUsdcPerShard(bidMaxQ96(A.floorUsdc, TICK_USDC, bid.ticks));
  const supply = BigInt(TOTAL_SHARDS) * SHARD;
  const bidShards = (BigInt(bid.shardsX10) * SHARD) / 10n;
  const fillShards = bidShards < BigInt(FOR_SALE) * SHARD ? bidShards : BigInt(FOR_SALE) * SHARD;
  const poolShards = (BigInt(FOR_SALE) * SHARD * (10_000n - feeBps)) / 10_000n;
  const target = redeemTarget(supply);
  const needShards = target > fillShards ? target - fillShards : 0n;
  if (needShards * 10n >= poolShards * 9n) throw new Error(`card A's pool (${formatUnits(poolShards, 18)} shards) can't supply the ${formatUnits(needShards, 18)} the buyer needs; raise its bid`);
  const poolUsdc = (clearingUsdc * poolShards) / SHARD;
  const raw = (poolUsdc * needShards) / (poolShards - needShards);
  const poolBuyUsdc = (((raw * 10_000n) / (10_000n - POOL_FEE_BPS)) * BUYOUT_MARGIN_BPS) / 10_000n;
  const appraisal = BigInt(plan.markets.A) / BigInt(TOTAL_SHARDS);
  const price = clearingUsdc > appraisal ? clearingUsdc : appraisal;
  const payout = (price * (supply - target)) / SHARD;
  return { clearingUsdc, fillShards, poolShards, needShards, poolBuyUsdc, redeemUsdc: payout + (payout * feeBps) / 10_000n + 1n };
}

export type Budget = { perRole: Record<Role, bigint>; totalUsdc: bigint; buyoutUsdc: bigint; tradesUsdc: bigint; ethTarget: Record<Role | "vendor", bigint> };

/**
 * USDC each seed wallet must hold before the run. Bids count at their full budget (refunds and payouts come back only
 * later); the pool buys on B at their USDC in; card A's buyer also needs the pool buy and the redeem (buyoutEstimate).
 */
export function budget(plan: ScenarioPlan, feeBps: bigint): Budget {
  const perRole = Object.fromEntries(ROLES.map((r) => [r, 0n])) as Record<Role, bigint>;
  for (const a of Object.values(plan.auctions)) for (const b of a.bids) perRole[b.bidder] += bidBudget(a.floorUsdc, TICK_USDC, b);
  let tradesUsdc = 0n;
  for (const t of TRADES_B) if (t.side === "buy") { perRole[t.role] += t.amount; tradesUsdc += t.amount; }
  const est = buyoutEstimate(plan, feeBps);
  const buyoutUsdc = est.poolBuyUsdc + est.redeemUsdc;
  perRole[BUYER] += buyoutUsdc;
  const totalUsdc = Object.values(perRole).reduce((a, b) => a + b, 0n);
  return {
    perRole,
    totalUsdc,
    buyoutUsdc,
    tradesUsdc,
    // Half of each target (the top-up threshold) is at least twice the gas the role spent in a fork dry run at ~1 gwei:
    // owner0 shards twice and settles A and C (each settle now seeds a pool), the buyer swaps, redeems and re-shards.
    ethTarget: { owner0: parseEther("0.06"), owner1: parseEther("0.03"), bidder0: parseEther("0.03"), bidder1: parseEther("0.01"), bidder2: parseEther("0.01"), bidder3: parseEther("0.01"), vendor: parseEther("0.04") },
  };
}

/** Top-up needed to bring `have` to `target`, or 0 when `have` is at least half of it (the threshold). */
export const ethTopUp = (have: bigint, target: bigint) => (have * 2n >= target ? 0n : target - have);
export const usdcTopUp = (have: bigint, need: bigint) => (have >= need ? 0n : need - have);

export function faucetMessage(deployer: Address, need: bigint, have: bigint): string | null {
  if (have >= need) return null;
  return `Top up ${deployer} at https://faucet.circle.com (Ethereum Sepolia, USDC). Need ${formatUnits(need, 6)}, have ${formatUnits(have, 6)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// ENS names across redeploys (pure)

/**
 * A collector handle. The ENS registry outlives a redeploy while CardNames doesn't: a seed wallet may still own its
 * handle from an earlier deployment, which the new CardNames can neither see (collectorLabels) nor re-register.
 */
export function handleStatus(h: { recorded: string; available: boolean; ensOwner: Address; wallet: Address }): "recorded" | "register" | "owned" | "taken" {
  if (h.recorded) return "recorded";
  if (h.available) return "register";
  return h.ensOwner.toLowerCase() === h.wallet.toLowerCase() ? "owned" : "taken";
}

// ---------------------------------------------------------------------------------------------------------------------
// Tickets (pure)

/** A synthetic World ID nullifier for a seed wallet: nothing real is bound. */
export const seedNullifier = (address: Address) => BigInt(keccak256(toHex(`kura:seed:${address.toLowerCase()}`)));

export function humanTicket(subject: Address, nowSec: bigint, ttl = BID_TTL_SEC): Ticket {
  return { kind: TicketKind.HUMAN, subject, nullifier: seedNullifier(subject), expiresAt: nowSec + ttl };
}

export function passportTicket(holder: Address, nowSec: bigint, ttl = PASSPORT_TTL_SEC): Ticket {
  // Single use: CardVault marks the digest used, so the time in the nullifier keeps a rerun from colliding.
  return { kind: TicketKind.PASSPORT, subject: holder, nullifier: BigInt(keccak256(toHex(`kura:seed:passport:${holder.toLowerCase()}:${nowSec}`))), expiresAt: nowSec + ttl };
}

// ---------------------------------------------------------------------------------------------------------------------
// Modes and the broadcast guard (pure)

export type Mode = "plan" | "dry-run" | "broadcast";
export type Args = { mode: Mode; liveBlocks: number; forkUrl?: string; deployments?: string };

export function parseArgs(argv: readonly string[]): Args {
  const dry = argv.includes("--dry-run");
  const live = argv.includes("--broadcast");
  if (dry && live) throw new Error("pick one of --dry-run and --broadcast");
  const i = argv.indexOf("--live-blocks");
  const liveBlocks = i >= 0 ? Number(argv[i + 1]) : DEFAULT_LIVE_BLOCKS;
  if (!Number.isInteger(liveBlocks) || liveBlocks < 2 || liveBlocks > 1_000_000) throw new Error("--live-blocks must be an integer in 2..1000000");
  const value = (flag: string) => {
    const j = argv.indexOf(flag);
    if (j < 0) return undefined;
    const v = argv[j + 1];
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (!dry) throw new Error(`${flag} is only for --dry-run (a broadcast uses contracts/deployments/sepolia.json and the configured RPC)`);
    return v;
  };
  const forkUrl = value("--fork-url");
  const deployments = value("--deployments");
  const args: Args = { mode: dry ? "dry-run" : live ? "broadcast" : "plan", liveBlocks };
  if (forkUrl) args.forkUrl = forkUrl;
  if (deployments) args.deployments = deployments;
  return args;
}

/** Why a broadcast must not start here, or null. Only an interactive terminal outside CI may broadcast. */
export function broadcastRefusal(env: { isTTY: boolean | undefined; ci: string | undefined }): string | null {
  if (env.ci && env.ci !== "false" && env.ci !== "0") return "refusing to broadcast in CI";
  if (!env.isTTY) return "refusing to broadcast without an interactive terminal (stdin is not a TTY)";
  return null;
}

export const isBroadcastConfirmation = (answer: string) => answer.trim() === "BROADCAST";

// ---------------------------------------------------------------------------------------------------------------------
// Resumable steps (pure logic, injected chain calls)

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
/**
 * `sent`: signed, its hash and raw bytes saved before broadcast; `failed`: the last send reverted (hashes kept for the
 * record) and the step runs afresh next time.
 */
export type StepRecord = { status: "sent" | "done" | "skipped" | "failed"; hash?: Hex; raw?: Hex; out?: Json; failed?: Hex[] };
export type RehearseState = { version: 1; network: string; vault?: Address; fromBlock?: string; wallets?: Record<string, Address>; plan?: ScenarioPlan; steps: Record<string, StepRecord> };

export const newState = (network: string): RehearseState => ({ version: 1, network, steps: {} });

/** One state file per network and vault: a redeploy (new vault, new deploy block) never resumes an old run. */
export const statePathFor = (root: string, network: string, vault: Address) => join(root, `scripts/.rehearse-state.${network}.${vault.toLowerCase()}.json`);

export function stateVaultError(state: RehearseState, vault: Address): string | null {
  if (!state.vault || state.vault.toLowerCase() === vault.toLowerCase()) return null;
  return `the state file was written for another vault (${state.vault}, now ${vault}); it belongs to an older deployment`;
}

export type ReceiptLike = { status: "success" | "reverted"; blockNumber: bigint; transactionHash: Hex };
export type StepIO<R extends ReceiptLike> = {
  /** Returns a value when the step's effect is already on chain (no tx needed), else undefined. */
  skip?: () => Promise<Json | undefined>;
  /** Simulates and signs the transaction locally (explicit nonce); returns the serialized signed tx. Nothing is sent. */
  sign: () => Promise<Hex>;
  /** Broadcasts a signed tx (eth_sendRawTransaction). */
  broadcast: (raw: Hex) => Promise<unknown>;
  /** The receipt, or null when the tx isn't mined within the wait. */
  wait: (hash: Hex) => Promise<R | null>;
  /** The receipt right now, or null (no waiting). */
  receipt: (hash: Hex) => Promise<R | null>;
  /** Whether the node knows the tx at all (pending or mined). */
  lookup: (hash: Hex) => Promise<boolean>;
  /** Whether the sender's mined nonce has passed this tx's nonce (so it, or another tx with its nonce, landed). */
  nonceUsed: (raw: Hex) => Promise<boolean>;
  /** The sender's nonces: `pending` above `latest` means one of its txs is still in flight. */
  nonces?: () => Promise<{ pending: number; latest: number }>;
  /** Waits between hash lookups after a refused broadcast (injected so tests don't wait). */
  sleep?: (ms: number) => Promise<void>;
  parse?: (receipt: R) => Json;
  save: (state: RehearseState) => void;
};

/** A step already sent or finished: it must not be prepared (or sent) again. */
export const isStarted = (rec: StepRecord | undefined) => rec?.status === "done" || rec?.status === "skipped" || rec?.status === "sent";

/** The tx hash of a serialized signed transaction (legacy and typed alike). */
export const txHashOf = (raw: Hex) => keccak256(raw);

/** A broadcast error that only means the node already has this exact tx. */
export const isKnownTxError = (e: unknown) => /already known|known transaction/i.test(errorText(e));
const errorText = (e: unknown) => (e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : String(e));
const shortError = (e: unknown) => (e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)).split("\n")[0];

/** After a refused broadcast, how often and how far apart to look the hash up before failing the step (~15 s). */
export const REFUSED_LOOKUPS = 5;
export const REFUSED_LOOKUP_MS = 3_000;

export const stuckHint = (hash: Hex) => `check ${hash} on Etherscan; don't use the seed/vendor/deployer keys elsewhere during the run`;

/**
 * Runs one step at most once, and never loops on a tx that can't land.
 * - Done or skipped: returns the recorded output.
 * - New: checks `skip`, signs locally, saves the hash and the raw tx as "sent", then broadcasts. If the node refuses it,
 *   the hash is looked up REFUSED_LOOKUPS times over ~15 s (a node can refuse a tx that another node already relays);
 *   only when it never shows up is the step marked failed with the node's reason (the next run signs afresh).
 * - Failed before: refuses to re-sign while the sender has a tx in flight (pending nonce above latest), so a slow
 *   earlier tx can't be doubled by a new one; rerun once it lands or drops.
 * - Sent (resumed): a hash the node doesn't know is re-broadcast at once, the same raw tx, never re-signed.
 * - Not mined after the wait: if the sender's nonce has moved past the tx's, it was replaced; then `skip` decides
 *   whether the effect is on chain anyway (skipped), else the step is failed. Otherwise the same tx is re-broadcast
 *   ("already known" is fine; underpriced or insufficient funds fail the step) and waited for once more.
 * - A reverted receipt fails the step. A tx still pending at the end stays "sent" with a recovery hint.
 */
export async function runStep<R extends ReceiptLike>(state: RehearseState, id: string, io: StepIO<R>): Promise<{ out: Json; hash?: Hex; fresh: boolean; receipt?: R }> {
  const rec = state.steps[id];
  if (rec && (rec.status === "done" || rec.status === "skipped")) return { out: rec.out ?? null, hash: rec.hash, fresh: false };

  const fail = (hash: Hex, why: string) => {
    state.steps[id] = { status: "failed", failed: [...(rec?.failed ?? []), hash] };
    io.save(state);
    return new Error(`step ${id}: ${why}`);
  };
  const skipped = (out: Json) => {
    state.steps[id] = { status: "skipped", out, failed: rec?.failed };
    io.save(state);
    return { out, fresh: false };
  };
  type Outcome = { receipt: R } | { skipped: Json };
  /** The tx's nonce went to another tx: it can never land. */
  const replaced = async (hash: Hex): Promise<Outcome> => {
    const r = await io.receipt(hash);
    if (r) return { receipt: r };
    const already = io.skip ? await io.skip() : undefined;
    if (already !== undefined) return { skipped: already };
    throw fail(hash, `its nonce was used by another transaction, so ${hash} will never land; the next run signs it afresh`);
  };
  /** Re-sends the same raw tx; null when it is (still) out there, an outcome when it was replaced. */
  const rebroadcast = async (hash: Hex, raw: Hex): Promise<Outcome | null> => {
    try {
      await io.broadcast(raw);
      return null;
    } catch (e) {
      if (isKnownTxError(e)) return null;
      if (await io.nonceUsed(raw)) return replaced(hash);
      throw fail(hash, `the node refused ${hash}: ${shortError(e)}`);
    }
  };

  let hash: Hex;
  let raw: Hex | undefined;
  let early: Outcome | null = null;
  if (rec?.status === "sent" && rec.hash) {
    hash = rec.hash;
    raw = rec.raw;
    if (raw && !(await io.lookup(hash))) early = await rebroadcast(hash, raw);
  } else {
    if (io.skip) {
      const already = await io.skip();
      if (already !== undefined) return skipped(already);
    }
    if (rec?.status === "failed" && io.nonces) {
      const { pending, latest } = await io.nonces();
      if (pending > latest) {
        throw new Error(`step ${id}: not re-signing while the sender has ${pending - latest} transaction${pending - latest === 1 ? "" : "s"} in flight (pending nonce ${pending} > latest ${latest}); wait for ${pending - latest === 1 ? "it" : "them"} to land or drop, then rerun. ${rec.failed?.length ? stuckHint(rec.failed.at(-1)!) : ""}`.trim());
      }
    }
    raw = await io.sign();
    hash = txHashOf(raw);
    state.steps[id] = { status: "sent", hash, raw, failed: rec?.failed };
    io.save(state);
    try {
      await io.broadcast(raw);
    } catch (e) {
      const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      let known = await io.lookup(hash);
      for (let i = 1; !known && i < REFUSED_LOOKUPS; i++) {
        await sleep(REFUSED_LOOKUP_MS);
        known = await io.lookup(hash);
      }
      if (!known) throw fail(hash, `the node refused ${hash}: ${shortError(e)}`);
    }
  }

  if (early && "skipped" in early) return skipped(early.skipped);
  let receipt: R | null = early ? early.receipt : await io.wait(hash);
  if (!receipt && raw) {
    const next = (await io.nonceUsed(raw)) ? await replaced(hash) : await rebroadcast(hash, raw);
    if (next && "skipped" in next) return skipped(next.skipped);
    receipt = next ? next.receipt : await io.wait(hash);
  }
  if (!receipt) throw new Error(`step ${id}: ${hash} is not mined yet; rerun to keep waiting (the same signed tx is re-broadcast, never a new one). ${stuckHint(hash)}`);
  if (receipt.status !== "success") throw fail(hash, `reverted in ${hash}`);
  const out = io.parse ? io.parse(receipt) : null;
  state.steps[id] = { status: "done", hash, out, failed: rec?.failed };
  io.save(state);
  return { out, hash, fresh: true, receipt };
}

// ---------------------------------------------------------------------------------------------------------------------
// Caps and redaction (pure)

/** Hard ceilings: a plan above either is refused before anything is signed. */
export const MAX_TOTAL_USDC = 10n * USDC;
export const MAX_TOTAL_ETH = parseEther("0.2");

export function budgetCapError(b: Budget): string | null {
  const eth = Object.values(b.ethTarget).reduce((x, y) => x + y, 0n);
  if (b.totalUsdc > MAX_TOTAL_USDC) return `the plan needs ${formatUnits(b.totalUsdc, 6)} USDC, above the ${formatUnits(MAX_TOTAL_USDC, 6)} USDC cap; pick cheaper cards`;
  if (eth > MAX_TOTAL_ETH) return `the ETH top-ups reach ${formatEther(eth)} ETH, above the ${formatEther(MAX_TOTAL_ETH)} ETH cap`;
  return null;
}

/** Hides RPC keys in anything printed: an Alchemy-style /v2/<key> segment and any configured RPC URL's path. */
export function redact(text: string, urls: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const u of urls) {
    if (!u) continue;
    try {
      const { origin } = new URL(u);
      out = out.split(u).join(`${origin}/<redacted>`);
    } catch {
      /* not a URL */
    }
  }
  return out.replace(/(\/v[23]\/)[A-Za-z0-9_-]{8,}/g, "$1<redacted>");
}

const BIG = "$big:";
export const encodeState = (s: RehearseState) => JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? `${BIG}${v}` : v), 2) + "\n";
export const decodeState = (text: string): RehearseState =>
  JSON.parse(text, (_k, v) => (typeof v === "string" && v.startsWith(BIG) ? BigInt(v.slice(BIG.length)) : v)) as RehearseState;

// ---------------------------------------------------------------------------------------------------------------------
// Runtime

type Wallet = { role: Role | "vendor" | "deployer"; account: Account; address: Address };
type Ctx = {
  mode: Exclude<Mode, "plan">;
  network: "fork" | "sepolia";
  pub: PublicClient;
  rpcUrl: string;
  d: Deployments;
  state: RehearseState;
  statePath: string;
  deployer: Wallet;
  vendor: Wallet;
  signer: PrivateKeyAccount;
  seeds: Record<Role, Wallet>;
  log: { id: string; hash?: Hex; note?: string }[];
  fees: bigint;
  gas: Map<string, bigint>;
  /** Some steps were finished by an earlier run: run-wide balance deltas can't be asserted. */
  resumed: boolean;
};

function loadDotEnv() {
  const file = join(ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file); // never overrides variables already set in the shell
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

function loadDeployments(path = "contracts/deployments/sepolia.json"): Deployments {
  return DeploymentsSchema.parse(JSON.parse(readFileSync(resolve(ROOT, path), "utf8")));
}

const txUrl = (network: string, hash: Hex) => (network === "sepolia" ? `https://sepolia.etherscan.io/tx/${hash}` : `${hash} (fork)`);
const usd = (v: bigint) => {
  const [whole, frac = ""] = formatUnits(v, 6).split(".");
  return `$${whole}.${frac.padEnd(2, "0")}`;
};

async function scryfallCard(id: string): Promise<PrintingPrices & { name: string; set_name: string; finishes: string[]; image_uris?: { png?: string; normal?: string }; card_faces?: { image_uris?: { png?: string; normal?: string } }[] }> {
  const res = await fetch(`https://api.scryfall.com/cards/${id}`, { headers: { "User-Agent": "kura-rehearse/1.0", Accept: "application/json" } });
  if (!res.ok) throw new Error(`Scryfall ${id}: HTTP ${res.status}`);
  await new Promise((r) => setTimeout(r, 120)); // Scryfall asks for 50–100 ms between requests
  return res.json();
}

type CardInfo = { key: CardKey; scryfallId: string; name: string; setName: string; slug: string; setCode: string; lang: string; imageUrl: string; description: string; marketUsdc: bigint };

async function loadCards(): Promise<Record<CardKey, CardInfo>> {
  const out = {} as Record<CardKey, CardInfo>;
  for (const key of Object.keys(CARDS) as CardKey[]) {
    const c = await scryfallCard(CARDS[key].scryfallId);
    const description = `${c.name}, ${c.set_name}`; // the scan station's mint description (no ", foil": non-foil printings)
    const quote = await quoteMarketPrice({
      printing: c,
      finish: finishOf(description, c),
      condition: "NM",
      englishPrinting: async (set, num) => scryfallCard(`${set}/${num}`).catch(() => null),
    });
    const market = quoteUsdc(quote);
    if (!market) throw new Error(`card ${key} (${c.name}, ${c.set}) has no Scryfall USD price; pick another printing`);
    const img = c.image_uris ?? c.card_faces?.find((f) => f.image_uris)?.image_uris ?? {};
    out[key] = { key, scryfallId: c.id, name: c.name, setName: c.set_name, slug: slugify(c.name), setCode: setCode(c.set), lang: c.lang, imageUrl: img.png ?? img.normal ?? "", description, marketUsdc: market };
  }
  return out;
}

function seedWallets(mnemonic: string): Record<Role, Wallet> {
  return Object.fromEntries(ROLES.map((role, i): [Role, Wallet] => {
    const account = mnemonicToAccount(mnemonic, { addressIndex: i });
    return [role, { role, account, address: account.address }];
  })) as unknown as Record<Role, Wallet>;
}

function printPlan(cards: Record<CardKey, CardInfo>, plan: ScenarioPlan, b: Budget, seeds: Record<Role, Wallet> | null, feeBps: bigint) {
  console.log("\nWallets (SEED_MNEMONIC, addressIndex 0..5)");
  for (const r of ROLES) console.log(`  ${r.padEnd(8)} ${HANDLES[r]}.kura.eth  ${seeds ? seeds[r].address : "(set SEED_MNEMONIC)"}  USDC ${usd(b.perRole[r])}  ETH ≥ ${formatEther(b.ethTarget[r] / 2n)} (top up to ${formatEther(b.ethTarget[r])})`);
  console.log("\nCards (condition NM, priced with apps/web/src/lib/pricing.ts)");
  for (const k of Object.keys(cards) as CardKey[]) {
    const c = cards[k];
    console.log(`  ${k}  ${c.name} (${c.setCode.toUpperCase()}) ${c.scryfallId}  market ${usd(c.marketUsdc)}  → ${CARDS[k].owner}  ${CARDS[k].role}`);
  }
  console.log("\nAuctions (16 shards, tick $0.01)");
  for (const [k, a] of Object.entries(plan.auctions)) {
    const bids = a.bids.map((x) => `${x.bidder} ${x.shardsX10 / 10} @ ${usd(q96ToUsdcPerShard(bidMaxQ96(a.floorUsdc, TICK_USDC, x.ticks)))} = ${usd(bidBudget(a.floorUsdc, TICK_USDC, x))}`).join("; ");
    console.log(`  ${k.padEnd(2)} forSale ${FOR_SALE} (the other ${TOTAL_SHARDS - FOR_SALE} seed the pool if it graduates), floor ${usd(a.floorUsdc)}, reserve ${usd(a.reserveUsdc)}, ${a.durationBlocks} blocks. Bids: ${bids}`);
  }
  console.log("\nPool trades (Universal Router, 1% slippage)");
  for (const t of TRADES_B) console.log(`  ${t.id}  ${t.role.padEnd(8)} ${t.side === "buy" ? `buys B shards with ${usd(t.amount)}` : `sells up to ${formatUnits(t.amount, 18)} B shards`}`);
  const est = buyoutEstimate(plan, feeBps);
  console.log(`  A buyout: ${BUYER} fills ≤ ${formatUnits(est.fillShards, 18)} shards at ≤ ${usd(est.clearingUsdc)}, buys ${formatUnits(est.needShards, 18)} from the pool (≤ ${usd(est.poolBuyUsdc)} with a ×${Number(BUYOUT_MARGIN_BPS) / 10_000} margin), redeems (≤ ${usd(est.redeemUsdc)})`);
  console.log(`\nBudget: ${usd(b.totalUsdc)} USDC in total from the deployer (buyout of A ≤ ${usd(b.buyoutUsdc)} incl. the ${Number(feeBps) / 100}% fee, B buys ${usd(b.tradesUsdc)}).`);
  const eth = Object.values(b.ethTarget).reduce((x, y) => x + y, 0n);
  console.log(`ETH: at most ${formatEther(eth)} Sepolia ETH of top-ups (seed wallets and the vendor, each only when below half its target).`);
}

// --- chain helpers ---------------------------------------------------------------------------------------------------

function saveState(ctx: Ctx) {
  writeFileSync(ctx.statePath, encodeState(ctx.state));
}

/**
 * Chain calls for runStep: `sign` simulates the call (so a revert is decoded before anything is signed), prepares it
 * with the account's pending nonce and signs it locally; `broadcast` sends the raw bytes; `wait` gives up with null.
 */
function txIO(ctx: Ctx, from: Wallet, tx: () => Promise<{ to: Address; data?: Hex; value?: bigint; simulate?: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint } }>) {
  const wallet = createWalletClient({ account: from.account, chain: sepolia, transport: http(ctx.rpcUrl) });
  return {
    sign: async () => {
      const t = await tx();
      if (t.simulate) await ctx.pub.simulateContract({ ...t.simulate, account: from.account } as never);
      const nonce = await ctx.pub.getTransactionCount({ address: from.address, blockTag: "pending" });
      const prepared = await wallet.prepareTransactionRequest({ account: from.account, chain: sepolia, to: t.to, data: t.data, value: t.value, nonce } as never);
      return wallet.signTransaction(prepared as never) as Promise<Hex>;
    },
    broadcast: (raw: Hex) => wallet.sendRawTransaction({ serializedTransaction: raw }),
    receipt: (hash: Hex) => ctx.pub.getTransactionReceipt({ hash }).catch((e) => {
      if (e instanceof TransactionReceiptNotFoundError) return null;
      throw e;
    }),
    lookup: (hash: Hex) => ctx.pub.getTransaction({ hash }).then(() => true, (e) => {
      if (e instanceof TransactionNotFoundError) return false;
      throw e;
    }),
    nonceUsed: async (raw: Hex) => {
      const { nonce } = parseTransaction(raw);
      return (await ctx.pub.getTransactionCount({ address: from.address, blockTag: "latest" })) > (nonce ?? 0);
    },
    nonces: async () => {
      const [pending, latest] = await Promise.all([
        ctx.pub.getTransactionCount({ address: from.address, blockTag: "pending" }),
        ctx.pub.getTransactionCount({ address: from.address, blockTag: "latest" }),
      ]);
      return { pending, latest };
    },
    wait: (hash: Hex) =>
      ctx.pub.waitForTransactionReceipt({ hash, timeout: (ctx.network === "fork" ? 1 : 5) * 60_000, pollingInterval: ctx.network === "fork" ? 200 : 4_000 }).catch((e) => {
        if (e instanceof WaitForTransactionReceiptTimeoutError) return null;
        throw e;
      }),
  };
}

async function step(ctx: Ctx, id: string, from: Wallet, call: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint }, opts: { skip?: () => Promise<Json | undefined>; parse?: (r: TransactionReceipt) => Json; note?: string; fees?: boolean } = {}) {
  if (ctx.state.steps[id]?.status === "sent") ctx.resumed = true; // started by an earlier run: balance deltas span both
  const res = await runStep<TransactionReceipt>(ctx.state, id, {
    skip: opts.skip,
    ...txIO(ctx, from, async () => ({ to: call.address, data: encodeFunctionData(call as never), value: call.value, simulate: call })),
    parse: opts.parse,
    save: () => saveState(ctx),
  });
  // Fee totals are asserted as a balance delta over this run: any fee step not sent now makes that unknowable.
  if (!res.fresh && opts.fees) ctx.resumed = true;
  if (!res.fresh && ctx.state.steps[id]?.status === "done") ctx.resumed = true;
  if (res.receipt) ctx.gas.set(from.role, (ctx.gas.get(from.role) ?? 0n) + res.receipt.gasUsed * res.receipt.effectiveGasPrice);
  ctx.log.push({ id, hash: res.hash, note: res.fresh ? opts.note : `${opts.note ?? ""} (${ctx.state.steps[id]?.status === "skipped" ? "already on chain" : "resumed"})`.trim() });
  console.log(`  ${res.fresh ? "✓" : "·"} ${id.padEnd(26)} ${res.hash ? txUrl(ctx.network, res.hash) : "skipped: already on chain"}${opts.note ? `  ${opts.note}` : ""}`);
  return res;
}

/**
 * Logs since the run's first block (`state.fromBlock`), fetched in 500-block windows (RPC range limits). The on-chain
 * skips use it to recognise a step whose tx landed although the state file never heard back.
 */
async function findLogs(ctx: Ctx, address: Address, a: Abi, eventName: string, args: Record<string, unknown>) {
  const latest = await ctx.pub.getBlockNumber();
  const out: { args: Record<string, unknown>; blockNumber: bigint }[] = [];
  for (let from = BigInt(ctx.state.fromBlock ?? latest); from <= latest; from += 500n) {
    const to = from + 499n > latest ? latest : from + 499n;
    const logs = await ctx.pub.getContractEvents({ address, abi: a, eventName, args, fromBlock: from, toBlock: to } as never);
    out.push(...(logs as unknown as { args: Record<string, unknown>; blockNumber: bigint }[]));
  }
  return out;
}

const events = (r: TransactionReceipt, a: Abi, eventName: string) => parseEventLogs({ abi: a, logs: r.logs, eventName } as never) as unknown as { args: Record<string, unknown>; address: Address }[];

async function chainNow(ctx: Ctx): Promise<bigint> {
  return (await ctx.pub.getBlock()).timestamp;
}

const read = <T>(ctx: Ctx, address: Address, a: Abi, functionName: string, args: readonly unknown[] = []) => ctx.pub.readContract({ address, abi: a, functionName, args } as never) as Promise<T>;
const usdcOf = (ctx: Ctx, who: Address) => read<bigint>(ctx, ctx.d.usdc, abi.erc20, "balanceOf", [who]);
const shardsOf = (ctx: Ctx, token: Address, who: Address) => read<bigint>(ctx, token, abi.shardToken, "balanceOf", [who]);

type CardOnChain = { state: number; beneficialOwner: Address; shardToken: Address; auction: Address; endBlock: bigint };
const cardOf = (ctx: Ctx, id: bigint) => read<CardOnChain>(ctx, ctx.d.cardVault, abi.cardVault, "cards", [id]);
type ShardingOnChain = { graduated: boolean; settled: boolean; clearingPriceQ96: bigint; buyoutPerShard: bigint; redeemer: Address };
const shardingOf = (ctx: Ctx, token: Address) => read<ShardingOnChain>(ctx, ctx.d.cardVault, abi.cardVault, "shardings", [token]);
const STATE = ["None", "Whole", "Auctioning", "Sharded", "Released"];
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const shards = (v: bigint) => formatUnits(v, 18);

type Pool = { cardId: bigint; key: PoolKey; poolId: Hex; shardIsCurrency0: boolean };

/**
 * A sharding's pool, rebuilt from its PoolSeeded event with the shared v4 helpers (sorted currencies, Kura fee and
 * spacing, ShardMarket as the hook) and checked: poolIdOf(key) must be the event's pool id, and while it is still the
 * card's current pool, ShardMarket.poolKeyOf must return the same key. (A re-sharded card gets a new pool at settle.)
 */
async function poolOf(ctx: Ctx, cardId: bigint, shardToken: Address, seededPoolId: Hex): Promise<Pool> {
  const sorted = sortCurrencies(shardToken, ctx.d.usdc);
  const key: PoolKey = { currency0: sorted.currency0, currency1: sorted.currency1, fee: KURA_POOL_FEE, tickSpacing: KURA_TICK_SPACING, hooks: ctx.d.shardMarket };
  if (poolIdOf(key) !== seededPoolId) throw new Error(`card #${cardId}: poolIdOf(key) ${poolIdOf(key)} != PoolSeeded.poolId ${seededPoolId}`);
  const current = await read<Hex>(ctx, ctx.d.shardMarket, abi.shardMarket, "poolIdOf", [cardId]);
  if (current === seededPoolId) {
    const [currency0, currency1, fee, tickSpacing, hooks] = await read<readonly [Address, Address, number, number, Address]>(ctx, ctx.d.shardMarket, abi.shardMarket, "poolKeyOf", [cardId]);
    const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
    if (!same(currency0, key.currency0) || !same(currency1, key.currency1) || Number(fee) !== key.fee || Number(tickSpacing) !== key.tickSpacing || !same(hooks, key.hooks)) {
      throw new Error(`card #${cardId}: ShardMarket.poolKeyOf (${currency0}, ${currency1}, ${fee}, ${tickSpacing}, ${hooks}) differs from the key the shared helpers build`);
    }
  }
  return { cardId, key, poolId: seededPoolId, shardIsCurrency0: sorted.shardIsCurrency0 };
}

/** Whether this pool is still the card's current one (not replaced by a re-sharding's pool). */
const isCurrentPool = async (ctx: Ctx, pool: Pool) => (await read<Hex>(ctx, ctx.d.shardMarket, abi.shardMarket, "poolIdOf", [pool.cardId])) === pool.poolId;

const quoteParams = (pool: Pool, zeroForOne: boolean, exactAmount: bigint) => [{ poolKey: pool.key, zeroForOne, exactAmount, hookData: "0x" as Hex }] as const;
/** V4 Quoter, exact in: what `amountIn` buys. */
const quoteIn = async (ctx: Ctx, pool: Pool, zeroForOne: boolean, amountIn: bigint) =>
  (await ctx.pub.simulateContract({ address: ctx.d.v4Quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: quoteParams(pool, zeroForOne, amountIn) })).result[0];
/** V4 Quoter, exact out: what `amountOut` costs. */
const quoteOut = async (ctx: Ctx, pool: Pool, zeroForOne: boolean, amountOut: bigint) =>
  (await ctx.pub.simulateContract({ address: ctx.d.v4Quoter, abi: v4QuoterAbi, functionName: "quoteExactOutputSingle", args: quoteParams(pool, zeroForOne, amountOut) })).result[0];

async function poolPrice(ctx: Ctx, pool: Pool): Promise<bigint> {
  const [sqrtPriceX96] = await ctx.pub.readContract({ address: ctx.d.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [pool.poolId] });
  return usdcPerShardFromSqrtPrice(sqrtPriceX96, pool.shardIsCurrency0);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// --- scenario steps --------------------------------------------------------------------------------------------------

/** ETH and USDC top-ups: each computed from the live balance at send time, skipped when the wallet already has enough. */
async function fundWallets(ctx: Ctx, b: Budget) {
  console.log("\nFunding (from the deployer)");
  const targets: Wallet[] = [...ROLES.map((r) => ctx.seeds[r]), ctx.vendor];
  for (const w of targets) {
    const target = b.ethTarget[w.role as Role | "vendor"];
    const id = `eth-${w.role}`;
    let topUp = 0n;
    const res = await runStep<TransactionReceipt>(ctx.state, id, {
      skip: async () => {
        topUp = ethTopUp(await ctx.pub.getBalance({ address: w.address }), target);
        return topUp === 0n ? "enough" : undefined;
      },
      ...txIO(ctx, ctx.deployer, async () => ({ to: w.address, value: topUp })),
      save: () => saveState(ctx),
    });
    ctx.log.push({ id, hash: res.hash });
    console.log(`  ${res.fresh ? "✓" : "·"} ${id.padEnd(26)} ${res.hash ? txUrl(ctx.network, res.hash) : "skipped: enough ETH"}${res.fresh ? `  +${formatEther(topUp)} ETH` : ""}`);
  }
  for (const r of ROLES) {
    const want = b.perRole[r];
    if (want === 0n) continue;
    let topUp = 0n;
    const id = `usdc-${r}`;
    const res = await runStep<TransactionReceipt>(ctx.state, id, {
      skip: async () => {
        topUp = usdcTopUp(await usdcOf(ctx, ctx.seeds[r].address), want);
        return topUp === 0n ? "enough" : undefined;
      },
      ...txIO(ctx, ctx.deployer, async () => {
        const call = { address: ctx.d.usdc, abi: abi.erc20 as Abi, functionName: "transfer", args: [ctx.seeds[r].address, topUp] as const };
        return { to: ctx.d.usdc, data: encodeFunctionData(call as never), simulate: call };
      }),
      save: () => saveState(ctx),
    });
    ctx.log.push({ id, hash: res.hash });
    console.log(`  ${res.fresh ? "✓" : "·"} ${id.padEnd(26)} ${res.hash ? txUrl(ctx.network, res.hash) : "skipped: enough USDC"}${res.fresh ? `  +${usd(topUp)}` : ""}`);
  }
}

async function registerHandles(ctx: Ctx) {
  console.log("\nCollector handles");
  for (const r of ROLES) {
    const w = ctx.seeds[r];
    const label = HANDLES[r];
    await step(ctx, `handle-${r}`, w, { address: ctx.d.cardNames, abi: abi.cardNames, functionName: "registerCollector", args: [label] }, {
      note: `${label}.kura.eth`,
      skip: async () => {
        const recorded = await read<string>(ctx, ctx.d.cardNames, abi.cardNames, "collectorLabels", [w.address]);
        const available = recorded ? false : await read<boolean>(ctx, ctx.d.cardNames, abi.cardNames, "isAvailable", [label]);
        const ensOwner = recorded || available ? ZERO : await read<Address>(ctx, ctx.d.ensRegistry, abi.ensRegistry, "findOwner", [label]);
        switch (handleStatus({ recorded, available, ensOwner, wallet: w.address })) {
          case "recorded": return recorded;
          case "register": return undefined;
          case "owned":
            console.log(`    ${label}.kura.eth is still ${r}'s from an earlier deployment (this CardNames has no record of it)`);
            return `${label} (earlier deployment)`;
          case "taken": throw new Error(`${label}.kura.eth is taken by another wallet; change HANDLES in scripts/rehearse.ts`);
        }
      },
    });
  }
}

async function approvePermit2(ctx: Ctx, plan: ScenarioPlan) {
  console.log("\nUSDC → Permit2 approvals (bidders, once)");
  const bidders = new Set(Object.values(plan.auctions).flatMap((a) => a.bids.map((b) => b.bidder)));
  for (const r of bidders) {
    const w = ctx.seeds[r];
    await step(ctx, `permit2-${r}`, w, { address: ctx.d.usdc, abi: abi.erc20, functionName: "approve", args: [ctx.d.permit2, 2n ** 256n - 1n] }, {
      skip: async () => ((await read<bigint>(ctx, ctx.d.usdc, abi.erc20, "allowance", [w.address, ctx.d.permit2])) >= 10n ** 30n ? "approved" : undefined),
    });
  }
}

async function mintCards(ctx: Ctx, cards: Record<CardKey, CardInfo>): Promise<Record<CardKey, bigint>> {
  console.log("\nMint (vendor → owners)");
  const ids = {} as Record<CardKey, bigint>;
  for (const k of Object.keys(CARDS) as CardKey[]) {
    const c = cards[k];
    const to = ctx.seeds[CARDS[k].owner].address;
    const res = await step(ctx, `mint-${k}`, ctx.vendor, {
      address: ctx.d.cardVault, abi: abi.cardVault, functionName: "mint",
      args: [{ to, scryfallId: c.scryfallId, slug: c.slug, setCode: c.setCode, condition: "NM", language: c.lang, imageUrl: c.imageUrl, description: c.description }],
    }, {
      parse: (r) => String(events(r, abi.cardVault, "CardMinted")[0].args.id),
      note: `${c.name} → ${HANDLES[CARDS[k].owner]}`,
      // Already minted to this owner for this printing in this run (each seed owner gets each printing once).
      skip: async () => {
        const [m] = (await findLogs(ctx, ctx.d.cardVault, abi.cardVault, "CardMinted", { to })).filter((l) => l.args.scryfallId === c.scryfallId);
        return m ? String(m.args.id) : undefined;
      },
    });
    ids[k] = BigInt(res.out as string);
  }
  for (const k of Object.keys(ids) as CardKey[]) console.log(`  card ${k} = #${ids[k]} (${cards[k].slug}-${cards[k].setCode}-${ids[k]}.kura.eth)`);
  return ids;
}

type Sharded = { token: Address; auction: Address; startBlock: bigint; endBlock: bigint };

/** `nth`: which sharding of this card in this run the step is (0 first, 1 the re-shard). */
async function shard(ctx: Ctx, key: string, cardId: bigint, owner: Wallet, a: AuctionPlan, nth = 0): Promise<Sharded> {
  const outOf = (e: Record<string, unknown>) => ({ token: e.shardToken as string, auction: e.auction as string, startBlock: String(e.startBlock), endBlock: String(e.endBlock) });
  const res = await step(ctx, `shard-${key}`, owner, {
    address: ctx.d.cardVault, abi: abi.cardVault, functionName: "shardAndAuction",
    args: [cardId, shardParams(a)],
  }, {
    note: `${FOR_SALE}/${TOTAL_SHARDS} for sale, ${a.durationBlocks} blocks`,
    parse: (r) => outOf(events(r, abi.cardVault, "CardSharded")[0].args),
    skip: async () => {
      const e = (await findLogs(ctx, ctx.d.cardVault, abi.cardVault, "CardSharded", { id: cardId }))[nth];
      return e ? outOf(e.args) : undefined;
    },
  });
  const o = res.out as Record<string, string>;
  return { token: o.token as Address, auction: o.auction as Address, startBlock: BigInt(o.startBlock), endBlock: BigInt(o.endBlock) };
}

type PlacedBid = { key: string; bidder: Role; bidId: bigint; maxQ96: bigint; amount: bigint; block: bigint };

async function placeBids(ctx: Ctx, key: string, s: Sharded, a: AuctionPlan): Promise<PlacedBid[]> {
  const placed: PlacedBid[] = [];
  const tick = tickQ96(TICK_USDC);
  for (const b of a.bids) {
    const w = ctx.seeds[b.bidder];
    const amount = bidBudget(a.floorUsdc, TICK_USDC, b);
    await step(ctx, `p2-${key}-${b.bidder}`, w, { address: ctx.d.permit2, abi: abi.permit2, functionName: "approve", args: [ctx.d.usdc, s.auction, amount, Number((await chainNow(ctx)) + 30n * 24n * 3600n)] }, {
      skip: async () => {
        const [allowed, expiration] = await read<readonly [bigint, number, number]>(ctx, ctx.d.permit2, abi.permit2, "allowance", [w.address, ctx.d.usdc, s.auction]);
        return allowed >= amount && BigInt(expiration) > (await chainNow(ctx)) ? "approved" : undefined;
      },
    });
    const ticket = humanTicket(w.address, await chainNow(ctx));
    const sig = await ctx.signer.signTypedData({ domain: bidGateDomain(ctx.d.bidGateHook), types: TICKET_TYPES, primaryType: "Ticket", message: ticket });
    const hookData = encodeHookData(ticket, sig);
    // A bid must sit above the clearing price at its block; if demand already moved it, step the max up a tick at a time.
    let maxQ96 = bidMaxQ96(a.floorUsdc, TICK_USDC, b.ticks);
    if (!isStarted(ctx.state.steps[`bid-${key}-${b.bidder}`])) {
      for (let i = 0; i < 6; i++) {
        try {
          await ctx.pub.simulateContract({ address: s.auction, abi: abi.ccaAuction, functionName: "submitBid", args: [maxQ96, amount, w.address, hookData], account: w.account });
          break;
        } catch (e) {
          if (!String(e).includes("BidMustBeAboveClearingPrice") || i === 5) throw e;
          maxQ96 += tick;
        }
      }
    }
    const res = await step(ctx, `bid-${key}-${b.bidder}`, w, { address: s.auction, abi: abi.ccaAuction, functionName: "submitBid", args: [maxQ96, amount, w.address, hookData] }, {
      note: `${HANDLES[b.bidder]} ${usd(amount)} up to ${usd(q96ToUsdcPerShard(maxQ96))}/shard`,
      parse: (r) => {
        const e = events(r, abi.ccaAuction, "BidSubmitted")[0].args;
        return { bidId: String(e.id), maxQ96: String(e.priceQ96), block: String(r.blockNumber) };
      },
      // One bid per bidder per auction in this scenario: an existing one is this step's.
      skip: async () => {
        const [e] = await findLogs(ctx, s.auction, abi.ccaAuction, "BidSubmitted", { owner: w.address });
        return e ? { bidId: String(e.args.id), maxQ96: String(e.args.priceQ96), block: String(e.blockNumber) } : undefined;
      },
    });
    const o = res.out as Record<string, string>;
    placed.push({ key, bidder: b.bidder, bidId: BigInt(o.bidId), maxQ96: BigInt(o.maxQ96), amount, block: BigInt(o.block) });
  }
  return placed;
}

async function waitForBlock(ctx: Ctx, target: bigint) {
  const now = await ctx.pub.getBlockNumber();
  if (now >= target) return;
  if (ctx.network === "fork") {
    // In chunks: one large anvil_mine on a fork outlasts the RPC client's timeout.
    for (let at = now; at < target; ) {
      const n = target - at > 500n ? 500n : target - at;
      await ctx.pub.request({ method: "anvil_mine" as never, params: [toHex(n)] as never });
      at += n;
    }
    console.log(`  mined ${target - now} blocks on the fork (anvil_mine) to block ${target}`);
    return;
  }
  console.log(`  waiting for block ${target} (now ${now}, about ${Number(target - now) * 12}s)`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 12_000));
    const b = await ctx.pub.getBlockNumber();
    if (b >= target) return;
    process.stdout.write(`    block ${b}, ${target - b} to go\n`);
  }
}

type Settled = { graduated: boolean; clearingQ96: bigint; raised: bigint; fee: bigint; fresh: boolean };

async function settle(ctx: Ctx, key: string, cardId: bigint, token: Address, from: Wallet): Promise<Settled> {
  const outOf = (e: Record<string, unknown>) => ({ graduated: e.graduated as boolean, clearingQ96: String(e.clearingPriceQ96), raised: String(e.raisedUsdc), fee: String(e.feeUsdc) });
  const res = await step(ctx, `settle-${key}`, from, { address: ctx.d.cardVault, abi: abi.cardVault, functionName: "settle", args: [cardId] }, {
    fees: true,
    parse: (r) => outOf(events(r, abi.cardVault, "AuctionSettled")[0].args),
    skip: async () => {
      const [e] = await findLogs(ctx, ctx.d.cardVault, abi.cardVault, "AuctionSettled", { shardToken: token });
      return e ? outOf(e.args) : undefined;
    },
  });
  const o = res.out as Record<string, string | boolean>;
  const s = { graduated: o.graduated as boolean, clearingQ96: BigInt(o.clearingQ96 as string), raised: BigInt(o.raised as string), fee: BigInt(o.fee as string), fresh: res.fresh };
  console.log(`    ${key}: ${s.graduated ? "graduated" : "not graduated"}, clearing ${usd(q96ToUsdcPerShard(s.clearingQ96))}/shard, raised ${usd(s.raised)}, fee ${usd(s.fee)}`);
  return s;
}

/**
 * A graduated settle seeds the card's pool: exactly one PoolSeeded for this sharding, and (right after a fresh settle)
 * the owner holds no shards, since the held half and the unsold shards went to the pool. Not graduated: no pool.
 */
async function checkSeeding(ctx: Ctx, key: string, cardId: bigint, s: Sharded, set: Settled, owner: Wallet): Promise<Pool | null> {
  const seeded = (await findLogs(ctx, ctx.d.shardMarket, abi.shardMarket, "PoolSeeded", { cardId })).filter((l) => (l.args.shardToken as string).toLowerCase() === s.token.toLowerCase());
  if (!set.graduated) {
    assert(seeded.length === 0, `card ${key}: not graduated, so no pool was seeded`);
    return null;
  }
  assert(seeded.length === 1, `card ${key}: settle seeded its Uniswap v4 pool (PoolSeeded)`);
  if (set.fresh) assert((await shardsOf(ctx, s.token, owner.address)) === 0n, `card ${key}: the owner holds no shards (the held half went to the pool)`);
  const e = seeded[0].args;
  const pool = await poolOf(ctx, cardId, s.token, e.poolId as Hex);
  const opened = usdcPerShardFromSqrtPrice(e.sqrtPriceX96 as bigint, pool.shardIsCurrency0);
  assert((e.shardIsCurrency0 as boolean) === pool.shardIsCurrency0, `card ${key}: PoolSeeded.shardIsCurrency0 matches the address sort (shard is currency${pool.shardIsCurrency0 ? 0 : 1})`);
  console.log(`    pool ${pool.poolId}: opened at ${usd(opened)}/shard (clearing ${usd(q96ToUsdcPerShard(set.clearingQ96))}) with ${shards(e.shardAmount as bigint)} shards and ${usd(e.usdcAmount as bigint)}`);
  return pool;
}

/** ERC20 approve(Permit2) once, then Permit2 approve(token, Universal Router, max, far future). */
async function approveRouter(ctx: Ctx, w: Wallet, token: Address, label: string) {
  await step(ctx, `erc20-p2-${label}-${w.role}`, w, { address: token, abi: abi.erc20, functionName: "approve", args: [ctx.d.permit2, maxUint256] }, {
    skip: async () => ((await read<bigint>(ctx, token, abi.erc20, "allowance", [w.address, ctx.d.permit2])) >= 10n ** 30n ? "approved" : undefined),
  });
  await step(ctx, `p2-ur-${label}-${w.role}`, w, { address: ctx.d.permit2, abi: permit2AllowanceAbi, functionName: "approve", args: [token, ctx.d.universalRouter, maxUint160, Number(maxUint48)] }, {
    skip: async () => {
      const [amount, expiration] = await read<readonly [bigint, number, number]>(ctx, ctx.d.permit2, permit2AllowanceAbi, "allowance", [w.address, token, ctx.d.universalRouter]);
      return amount >= 2n ** 150n && BigInt(expiration) > (await chainNow(ctx)) + 86_400n ? "approved" : undefined;
    },
  });
}

type SwapOut = { shardDelta: bigint; usdcDelta: bigint } | null;

/** An exact-in swap through the Universal Router, quoted at sign time with 1% slippage. Returns the hook's ShardSwap deltas. */
async function swap(ctx: Ctx, id: string, w: Wallet, pool: Pool, side: "buy" | "sell", amountIn: bigint, note: string): Promise<{ out: SwapOut; fresh: boolean; checked: boolean }> {
  const started = isStarted(ctx.state.steps[id]);
  // A sent or finished step is never re-signed, so its args are not rebuilt (nor quoted).
  const quote = started ? 0n : await quoteIn(ctx, pool, isZeroForOne(side, pool.shardIsCurrency0), amountIn);
  const args = swapExecuteArgs(pool.key, pool.shardIsCurrency0, side, amountIn, minOut(quote), (await chainNow(ctx)) + 1800n);
  const res = await step(ctx, id, w, { address: ctx.d.universalRouter, abi: universalRouterAbi, functionName: "execute", args }, {
    note,
    parse: (r) => {
      const e = events(r, abi.shardMarket, "ShardSwap").find((x) => x.address.toLowerCase() === ctx.d.shardMarket.toLowerCase() && x.args.poolId === pool.poolId);
      return e ? { shardDelta: String(e.args.shardDelta), usdcDelta: String(e.args.usdcDelta) } : null;
    },
  });
  const o = res.out as Record<string, string> | null;
  const out = o ? { shardDelta: BigInt(o.shardDelta), usdcDelta: BigInt(o.usdcDelta) } : null;
  if (res.fresh) {
    assert(out, `${id}: the hook emitted ShardSwap`);
    console.log(`    ${side === "buy" ? `+${shards(out.shardDelta)} shards for ${usd(-out.usdcDelta)}` : `${shards(out.shardDelta)} shards for +${usd(out.usdcDelta)}`}; pool price now ${usd(await poolPrice(ctx, pool))}/shard`);
  }
  // Only a swap signed in this run has a known amountIn to check the signs against.
  if (res.fresh && !started && out) assert(swapSignsOk(side, amountIn, out.shardDelta, out.usdcDelta), `${id}: ShardSwap deltas have the trader's signs (${side})`);
  return { out, fresh: res.fresh, checked: !started };
}

/** Card B stays sharded: two buys and a sell give its chart some history, then the owner collects the fees. */
async function tradeB(ctx: Ctx, cardId: bigint, s: Sharded, pool: Pool) {
  console.log("\nCard B: trades on the pool (Universal Router, Permit2)");
  for (const t of TRADES_B) {
    const w = ctx.seeds[t.role];
    await approveRouter(ctx, w, t.side === "buy" ? ctx.d.usdc : s.token, t.side === "buy" ? "usdc" : "B");
    let amount = t.amount;
    if (t.side === "sell" && !isStarted(ctx.state.steps[t.id])) {
      const bal = await shardsOf(ctx, s.token, w.address);
      if (bal === 0n) throw new Error(`${HANDLES[t.role]} holds no card B shards to sell`);
      if (amount > bal / 2n) amount = bal / 2n;
    }
    await swap(ctx, t.id, w, pool, t.side, amount, t.side === "buy" ? `${HANDLES[t.role]} buys with ${usd(amount)}` : `${HANDLES[t.role]} sells ${shards(amount)} shards`);
  }
  const owner = ctx.seeds[CARDS.B.owner];
  const res = await step(ctx, "fees-B", owner, { address: ctx.d.shardMarket, abi: abi.shardMarket, functionName: "collectFees", args: [cardId] }, {
    note: `${HANDLES[CARDS.B.owner]} collects the pool fees`,
    parse: (r) => {
      const e = events(r, abi.shardMarket, "FeesCollected")[0]?.args;
      return e ? { lpOwner: e.lpOwner as string, shards: String(e.shardAmount), usdc: String(e.usdcAmount) } : null;
    },
  });
  const o = res.out as Record<string, string> | null;
  if (res.fresh) {
    assert(o && o.lpOwner.toLowerCase() === owner.address.toLowerCase(), `FeesCollected names ${HANDLES[CARDS.B.owner]} as the LP owner`);
    assert(BigInt(o.usdc) > 0n && BigInt(o.shards) > 0n, `the owner earned fees on both sides: ${usd(BigInt(o.usdc))} (buys) and ${shards(BigInt(o.shards))} shards (the sell)`);
  }
}

/** The redeem bound for a buyer holding `bal`: max(clearing, appraisal) for the shards it lacks, plus the vault fee. */
async function redeemQuote(ctx: Ctx, s: Sharded, plan: ScenarioPlan, bal: bigint) {
  const [supply, feeBps, sh] = await Promise.all([
    read<bigint>(ctx, s.token, abi.shardToken, "totalSupply"),
    read<number>(ctx, ctx.d.cardVault, abi.cardVault, "feeBps").then(BigInt),
    shardingOf(ctx, s.token),
  ]);
  // The redeem rule (apps/web/src/lib/buyout.ts): price = max(clearing, appraisal); payout for supply − balance; fee on top.
  const appraisal = marketPerShard(BigInt(plan.markets.A), TOTAL_SHARDS) ?? 0n;
  const clearing = q96ToUsdcPerShard(sh.clearingPriceQ96);
  const price = appraisal > clearing ? appraisal : clearing;
  const payout = (price * (supply - bal)) / SHARD;
  return { supply, appraisal, clearing, price, payout, fee: (payout * feeBps) / 10_000n };
}

/**
 * Card A's buyer took about half the shards in the auction; it buys from the pool, in chunks re-quoted with the V4 Quoter
 * (exact out) and re-checking its balance, until it holds the 80% redeem needs. The deployer first tops it up to the live
 * quote plus the redeem, so an estimate that was off doesn't strand the run.
 */
async function buyFromPool(ctx: Ctx, s: Sharded, pool: Pool, plan: ScenarioPlan) {
  console.log("\nCard A: the buyer buys from the pool up to 80%");
  const buyer = ctx.seeds[BUYER];
  if (isStarted(ctx.state.steps["redeem-A"])) return console.log("    (redeem already sent: nothing to buy)");
  await approveRouter(ctx, buyer, ctx.d.usdc, "usdc");
  const supply = await read<bigint>(ctx, s.token, abi.shardToken, "totalSupply");
  const target = redeemTarget(supply);
  const buy = isZeroForOne("buy", pool.shardIsCurrency0);
  let bal = await shardsOf(ctx, s.token, buyer.address);
  console.log(`    ${HANDLES[BUYER]} holds ${shards(bal)} of ${shards(supply)} from the auction; redeem needs ${shards(target)}`);

  const cost = bal < target ? await quoteOut(ctx, pool, buy, target - bal) : 0n;
  const r = await redeemQuote(ctx, s, plan, target);
  const want = (cost * 102n) / 100n + r.payout + r.fee + 1n;
  let topUp = 0n;
  const res = await runStep<TransactionReceipt>(ctx.state, "usdc-buyout-A", {
    skip: async () => {
      topUp = usdcTopUp(await usdcOf(ctx, buyer.address), want);
      if (topUp === 0n) return "enough";
      const have = await usdcOf(ctx, ctx.deployer.address);
      const short = faucetMessage(ctx.deployer.address, topUp, have);
      if (short && ctx.mode === "broadcast") throw new Error(short);
      if (short) await forkDealUsdc(ctx, ctx.deployer.address, topUp);
      return undefined;
    },
    ...txIO(ctx, ctx.deployer, async () => {
      const call = { address: ctx.d.usdc, abi: abi.erc20 as Abi, functionName: "transfer", args: [buyer.address, topUp] as const };
      return { to: ctx.d.usdc, data: encodeFunctionData(call as never), simulate: call };
    }),
    save: () => saveState(ctx),
  });
  ctx.log.push({ id: "usdc-buyout-A", hash: res.hash });
  console.log(`  ${res.fresh ? "✓" : "·"} ${"usdc-buyout-A".padEnd(26)} ${res.hash ? txUrl(ctx.network, res.hash) : "skipped: enough USDC"}  pool quote ${usd(cost)} + redeem ${usd(r.payout + r.fee)}${res.fresh ? `, +${usd(topUp)}` : ""}`);

  for (let i = 1; i <= 6; i++) {
    bal = await shardsOf(ctx, s.token, buyer.address);
    if (bal >= target) break;
    const id = `pool-buy-A-${i}`;
    const chunk = target - bal < BUYOUT_CHUNK ? target - bal : BUYOUT_CHUNK;
    // Exact-out quote for the chunk, spent exact in (+1 unit against rounding); the swap re-quotes it for its minimum.
    const amountIn = isStarted(ctx.state.steps[id]) ? 0n : (await quoteOut(ctx, pool, buy, chunk)) + 1n;
    await swap(ctx, id, buyer, pool, "buy", amountIn, `${HANDLES[BUYER]} buys ${shards(chunk)} shards`);
  }
  bal = await shardsOf(ctx, s.token, buyer.address);
  assert(bal * 5n >= supply * 4n, `${HANDLES[BUYER]} holds ${shards(bal)} of ${shards(supply)} card A shards (≥ 80%) after buying from the pool`);
}

async function checkpoints(ctx: Ctx, s: Sharded): Promise<ExitCheckpoint[]> {
  const logs = await ctx.pub.getContractEvents({ address: s.auction, abi: abi.ccaAuction, eventName: "CheckpointUpdated", fromBlock: s.startBlock, toBlock: "latest" } as never);
  return (logs as unknown as { args: { blockNumber: bigint; clearingPriceQ96: bigint } }[]).map((l) => ({ blockNumber: l.args.blockNumber, clearingPriceQ96: l.args.clearingPriceQ96 }));
}

/** Exit every bid through the web's exitRoute, then claim the filled ones. Returns each exit's fill and refund. */
async function exitAndClaim(ctx: Ctx, key: string, s: Sharded, settled: Settled, bids: PlacedBid[]) {
  const cps = await checkpoints(ctx, s);
  const exits: { bid: PlacedBid; tokens: bigint; refund: bigint; fresh: boolean }[] = [];
  for (const b of bids) {
    const w = ctx.seeds[b.bidder];
    const route = exitRoute({ bidId: b.bidId, maxPriceQ96: b.maxQ96, submittedBlock: b.block }, settled.graduated, cps, settled.clearingQ96);
    if (!route) throw new Error(`no fully filled checkpoint for bid ${b.bidId} on ${key}`);
    const res = await step(ctx, `exit-${key}-${b.bidder}`, w, { address: s.auction, abi: abi.ccaAuction, functionName: route.fn, args: route.args }, {
      note: route.fn,
      skip: async () => {
        const bid = await read<{ exitedBlock: bigint; tokensFilled: bigint }>(ctx, s.auction, abi.ccaAuction, "bids", [b.bidId]);
        return bid.exitedBlock !== 0n ? { tokensFilled: String(bid.tokensFilled), refund: "0" } : undefined;
      },
      parse: (r) => {
        const e = events(r, abi.ccaAuction, "BidExited")[0].args;
        return { tokensFilled: String(e.tokensFilled), refund: String(e.currencyRefunded) };
      },
    });
    const o = res.out as Record<string, string>;
    const tokens = BigInt(o.tokensFilled);
    if (res.fresh) console.log(`    bid ${b.bidId} (${HANDLES[b.bidder]}): ${formatUnits(tokens, 18)} shards filled, refund ${usd(BigInt(o.refund))}`);
    exits.push({ bid: b, tokens, refund: BigInt(o.refund), fresh: res.fresh });
    if (settled.graduated && tokens > 0n) {
      // claimTokens needs the exit first, and after the claim block (= the end block here).
      await step(ctx, `claim-${key}-${b.bidder}`, w, { address: s.auction, abi: abi.ccaAuction, functionName: "claimTokens", args: [b.bidId] }, {
        skip: async () => ((await read<{ tokensFilled: bigint }>(ctx, s.auction, abi.ccaAuction, "bids", [b.bidId])).tokensFilled === 0n ? "claimed" : undefined),
      });
    }
  }
  return exits;
}

async function redeemA(ctx: Ctx, cardId: bigint, s: Sharded, buyer: Wallet, plan: ScenarioPlan, pool: Pool) {
  console.log("\nCard A: buyout");
  const bal = await shardsOf(ctx, s.token, buyer.address);
  const { supply, appraisal, clearing, price, payout, fee } = await redeemQuote(ctx, s, plan, bal);
  console.log(`    ${HANDLES[BUYER]} holds ${shards(bal)}/${shards(supply)}; price max(${usd(clearing)}, appraisal ${usd(appraisal)}) = ${usd(price)}; payout ${usd(payout)} + fee ${usd(fee)}`);
  if (!ctx.state.steps["redeem-A"]) assert(bal * 5n >= supply * 4n, "the buyer of A holds at least 80% of the shards");
  const owner = buyer;
  await step(ctx, "approve-redeem-A", owner, { address: ctx.d.usdc, abi: abi.erc20, functionName: "approve", args: [ctx.d.cardVault, payout + fee] }, {
    skip: async () => ((await read<bigint>(ctx, ctx.d.usdc, abi.erc20, "allowance", [owner.address, ctx.d.cardVault])) >= payout + fee || ctx.state.steps["redeem-A"] ? "approved" : undefined),
  });
  const appr = { cardId, shardToken: s.token, usdcPerShard: appraisal, expiresAt: (await chainNow(ctx)) + APPRAISAL_TTL_SEC };
  const sig = await ctx.signer.signTypedData({ domain: cardVaultDomain(ctx.d.cardVault), types: APPRAISAL_TYPES, primaryType: "Appraisal", message: appr });
  const outOf = (e: Record<string, unknown>) => ({ price: String(e.buyoutPerShard), payout: String(e.payoutUsdc), fee: String(e.feeUsdc) });
  const res = await step(ctx, "redeem-A", owner, { address: ctx.d.cardVault, abi: abi.cardVault, functionName: "redeem", args: [cardId, appr, sig] }, {
    fees: true,
    parse: (r) => outOf(events(r, abi.cardVault, "CardRedeemed")[0].args),
    skip: async () => {
      const [e] = await findLogs(ctx, ctx.d.cardVault, abi.cardVault, "CardRedeemed", { shardToken: s.token });
      return e ? outOf(e.args) : undefined;
    },
  });
  const o = res.out as Record<string, string>;
  ctx.fees += BigInt(o.fee);
  if (res.fresh) assert(BigInt(o.payout) === payout && BigInt(o.fee) === fee, `redeem charged exactly the quoted ${usd(payout)} + ${usd(fee)}`);
  const holder = await read<Address>(ctx, ctx.d.cardVault, abi.cardVault, "ownerOf", [cardId]);
  const card = await cardOf(ctx, cardId);
  if (!ctx.state.steps["shard-A2"]) {
    assert(holder.toLowerCase() === owner.address.toLowerCase() && card.state === 1, "after the buyout the redeemer holds card A's NFT and it is Whole");
    assert((await read<bigint>(ctx, ctx.d.usdc, abi.erc20, "allowance", [owner.address, ctx.d.cardVault])) === 0n, "the buyout used the exact USDC approval");
  }

  // The redeem unwound the pool: frozen, its positions (principal, fees, dust) went to the card's original owner.
  const lp = ctx.seeds[CARDS.A.owner];
  const [unwound] = await findLogs(ctx, ctx.d.shardMarket, abi.shardMarket, "Unwound", { cardId });
  assert(unwound && (unwound.args.lpOwner as string).toLowerCase() === lp.address.toLowerCase(), `redeem unwound card A's pool to ${HANDLES[CARDS.A.owner]} (${unwound ? `${shards(unwound.args.shardAmount as bigint)} shards, ${usd(unwound.args.usdcAmount as bigint)}` : "no Unwound event"})`);
  if (await isCurrentPool(ctx, pool)) {
    assert(await read<boolean>(ctx, ctx.d.shardMarket, abi.shardMarket, "isFrozen", [cardId]), "card A's pool is frozen");
  } else console.log("  · card A has a newer pool (the live auction settled): isFrozen(cardId) now reads that one");
  await assertSwapReverts(ctx, pool, buyer);
  return { price: BigInt(o.price) };
}

/** After the buyout the hook rejects swaps: the quoter's simulated swap and a real Universal Router swap both revert. */
async function assertSwapReverts(ctx: Ctx, pool: Pool, w: Wallet) {
  const frozen = toFunctionSelector("Frozen()").slice(2);
  const why = (e: unknown) => {
    const text = `${String(e)} ${JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`;
    return text.toLowerCase().includes(frozen) || /Frozen/.test(text) ? "Frozen" : "reverted";
  };
  const buy = isZeroForOne("buy", pool.shardIsCurrency0);
  let quoted: string | null = null;
  await quoteIn(ctx, pool, buy, 10_000n).then(() => (quoted = null), (e) => (quoted = why(e)));
  assert(quoted, `quoting a buy on card A's pool reverts after the buyout (${quoted ?? "it did not"})`);
  let swapped: string | null = null;
  const args = swapExecuteArgs(pool.key, pool.shardIsCurrency0, "buy", 1n, 0n, (await chainNow(ctx)) + 1800n);
  await ctx.pub.simulateContract({ account: w.account, address: ctx.d.universalRouter, abi: universalRouterAbi, functionName: "execute", args }).then(() => (swapped = null), (e) => (swapped = why(e)));
  assert(swapped, `a Universal Router swap on card A's pool reverts after the buyout (${swapped ?? "it did not"})`);
}

async function claimPayouts(ctx: Ctx, s: Sharded, price: bigint, holders: Role[]) {
  console.log("\nCard A: minority payouts");
  for (const r of holders) {
    const w = ctx.seeds[r];
    const bal = await shardsOf(ctx, s.token, w.address);
    const before = await usdcOf(ctx, w.address);
    const res = await step(ctx, `payout-A-${r}`, w, { address: ctx.d.cardVault, abi: abi.cardVault, functionName: "claimPayout", args: [s.token] }, {
      skip: async () => (bal === 0n ? "nothing to claim" : undefined),
      parse: (rc) => String(events(rc, abi.cardVault, "PayoutClaimed")[0].args.usdc),
    });
    if (res.fresh) {
      const paid = BigInt(res.out as string);
      assert(paid === (price * bal) / SHARD && (await usdcOf(ctx, w.address)) - before === paid, `${HANDLES[r]} received ${usd(paid)} for ${formatUnits(bal, 18)} shards`);
    }
  }
}

async function indexerChecks(ctx: Ctx, ids: Record<CardKey, bigint>, tokenC: Address) {
  const url = process.env.PONDER_URL ?? process.env.NEXT_PUBLIC_PONDER_URL;
  if (!url) return console.log("  (PONDER_URL not set: indexer checks skipped)");
  const { createClient, inArray, eq } = await import("@ponder/client");
  const schema = await import("../apps/indexer/ponder.schema");
  const client = createClient(`${url.replace(/\/$/, "")}/sql`, { schema });
  // The schema's drizzle and @ponder/client's are separate copies: same runtime shape, different types (cf. lib/ponder-bridge).
  const t = <T>(x: unknown) => x as T;
  const want: Record<CardKey, string> = { A: "auctioning", B: "sharded", C: "sharded", D: "released", E: "whole" };
  for (let i = 0; i < 30; i++) {
    const rows = (await client.db.select().from(t<never>(schema.cards)).where(inArray(t<never>(schema.cards.id), Object.values(ids)))) as { id: bigint; state: string }[];
    const [c] = (await client.db.select().from(t<never>(schema.shardings)).where(eq(t<never>(schema.shardings.shardToken), tokenC))) as { graduated: boolean | null }[];
    const ok = (Object.keys(want) as CardKey[]).every((k) => rows.find((r) => r.id === ids[k])?.state === want[k]) && c?.graduated === false;
    if (ok) {
      assert(true, "indexer: A auctioning, B sharded, C sharded, D released, E whole");
      assert(c.graduated === false, "indexer: shardings.graduated === false for card C");
      return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error("indexer did not reach the expected card states within 150 s");
}

function writeManifest(ctx: Ctx, cards: Record<CardKey, CardInfo>, ids: Record<CardKey, bigint>, sh: Record<string, Sharded>, pools: Record<string, Pool>) {
  const dir = join(ROOT, "scripts/seed");
  mkdirSync(dir, { recursive: true });
  const manifest = {
    seed: true,
    network: "sepolia",
    chainId: 11155111,
    generatedAt: new Date().toISOString(),
    wallets: Object.fromEntries(ROLES.map((r) => [r, { address: ctx.seeds[r].address, handle: `${HANDLES[r]}.kura.eth` }])),
    cards: Object.fromEntries((Object.keys(ids) as CardKey[]).map((k) => [k, { id: ids[k].toString(), scryfallId: cards[k].scryfallId, name: cards[k].name, label: `${cards[k].slug}-${cards[k].setCode}-${ids[k]}`, owner: CARDS[k].owner, role: CARDS[k].role }])),
    shardings: Object.fromEntries(Object.entries(sh).map(([k, s]) => [k, { shardToken: s.token, auction: s.auction, startBlock: s.startBlock.toString(), endBlock: s.endBlock.toString() }])),
    pools: Object.fromEntries(Object.entries(pools).map(([k, p]) => [k, { poolId: p.poolId, shardIsCurrency0: p.shardIsCurrency0, frozen: k === "A" }])),
    txs: Object.fromEntries(Object.entries(ctx.state.steps).filter(([, s]) => s.hash).map(([id, s]) => [id, s.hash])),
  };
  writeFileSync(join(dir, "sepolia.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nManifest written: scripts/seed/sepolia.json`);
}

// --- anvil -----------------------------------------------------------------------------------------------------------

/**
 * Fork only: set `who`'s USDC balance. anvil_dealERC20 can't find Circle's slot (FiatToken keeps balances in a mapping
 * whose top bit is the blacklist flag), so probe the mapping slots with anvil_setStorageAt, keeping the one that works.
 */
async function forkDealUsdc(ctx: Ctx, who: Address, amount: bigint) {
  for (let slot = 0n; slot < 32n; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, slot]));
    const old = await ctx.pub.getStorageAt({ address: ctx.d.usdc, slot: key });
    await ctx.pub.request({ method: "anvil_setStorageAt" as never, params: [ctx.d.usdc, key, toHex(amount, { size: 32 })] as never });
    if ((await usdcOf(ctx, who)) === amount) return;
    await ctx.pub.request({ method: "anvil_setStorageAt" as never, params: [ctx.d.usdc, key, old ?? toHex(0n, { size: 32 })] as never });
  }
  throw new Error("could not find the USDC balance slot on the fork");
}

async function startAnvil(forkUrl: string, port: number): Promise<ChildProcess> {
  const child = spawn("nice", ["-n", "10", "anvil", "--fork-url", forkUrl, "--port", String(port), "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr?.on("data", (d) => (err += String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited: ${err}`);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill("SIGTERM");
  throw new Error("anvil did not start within 30 s");
}

// --- main ------------------------------------------------------------------------------------------------------------

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const { mode, liveBlocks } = args;
  const d = loadDeployments(args.deployments);
  const rpc = process.env.ALCHEMY_HTTP_URL ?? process.env.SEPOLIA_RPC_URL;

  if (mode === "broadcast") {
    const refusal = broadcastRefusal({ isTTY: process.stdin.isTTY, ci: process.env.CI });
    if (refusal) {
      console.error(refusal);
      process.exit(2);
    }
  }

  console.log("Loading cards from Scryfall…");
  const cards = await loadCards();
  const markets = Object.fromEntries((Object.keys(cards) as CardKey[]).map((k) => [k, cards[k].marketUsdc])) as Record<CardKey, bigint>;
  const network = mode === "broadcast" ? "sepolia" : "fork";
  const statePath = statePathFor(ROOT, network, d.cardVault);

  if (mode === "plan") {
    const feeBps = rpc ? BigInt(await createPublicClient({ chain: sepolia, transport: http(rpc) }).readContract({ address: d.cardVault, abi: abi.cardVault, functionName: "feeBps" })) : 250n;
    const plan = planScenario(markets, liveBlocks);
    const b = budget(plan, feeBps);
    const mnemonic = process.env.SEED_MNEMONIC;
    printPlan(cards, plan, b, mnemonic ? seedWallets(mnemonic) : null, feeBps);
    const cap = budgetCapError(b);
    if (cap) throw new Error(cap);
    if (rpc && process.env.DEPLOYER_PRIVATE_KEY) {
      const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex).address;
      const have = await createPublicClient({ chain: sepolia, transport: http(rpc) }).readContract({ address: d.usdc, abi: abi.erc20, functionName: "balanceOf", args: [deployer] });
      console.log(faucetMessage(deployer, b.totalUsdc, have) ?? `Deployer ${deployer} holds ${usd(have)} USDC: enough.`);
    }
    if (!mnemonic) console.log("SEED_MNEMONIC is not set: --dry-run uses a throwaway mnemonic; --broadcast requires it.");
    console.log("\nPlan only: nothing was sent. Run with --dry-run (fork) or --broadcast (Sepolia).");
    return;
  }

  if (!rpc) throw new Error("ALCHEMY_HTTP_URL (or SEPOLIA_RPC_URL) is not set");
  if (d.shardMarket === ZERO) throw new Error("the deployment has no ShardMarket (shardMarket is the zero address): run Deploy.s.sol first");
  const signer = privateKeyToAccount(need("SIGNER_PRIVATE_KEY") as Hex);
  if (signer.address.toLowerCase() !== d.signer.toLowerCase()) throw new Error(`SIGNER_PRIVATE_KEY is for ${signer.address}, but the contracts trust ${d.signer}`);
  console.log(`✓ signer ${signer.address} is the deployment's signer`);
  const vendorAcc = privateKeyToAccount(need("VENDOR_PRIVATE_KEY") as Hex);
  if (vendorAcc.address.toLowerCase() !== d.vendor.toLowerCase()) throw new Error(`VENDOR_PRIVATE_KEY is for ${vendorAcc.address}, but the vault's vendor is ${d.vendor}`);
  const deployerAcc = privateKeyToAccount(need("DEPLOYER_PRIVATE_KEY") as Hex);

  let mnemonic = process.env.SEED_MNEMONIC;
  if (!mnemonic) {
    if (mode === "broadcast") throw new Error("SEED_MNEMONIC is not set: the seed wallets must be recoverable after a broadcast");
    mnemonic = generateMnemonic(english);
    console.log("SEED_MNEMONIC is not set: using a throwaway mnemonic for this fork run.");
  }

  let anvil: ChildProcess | null = null;
  const cleanup = () => {
    if (anvil && anvil.exitCode === null) anvil.kill("SIGTERM");
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  let rpcUrl = rpc;
  if (mode === "dry-run") {
    console.log(`Starting anvil (nice -n 10) on :8546, forking ${args.forkUrl ? redact(args.forkUrl, [rpc]) : "Sepolia"}…`);
    anvil = await startAnvil(args.forkUrl ?? rpc, 8546);
    rpcUrl = "http://127.0.0.1:8546";
    rmSync(statePath, { force: true }); // a fork is fresh every run, so its state is too
  }
  const pub = createPublicClient({ chain: sepolia, transport: http(rpcUrl) }) as PublicClient;
  if ((await pub.getChainId()) !== 11155111) throw new Error("the RPC is not Sepolia (chain id 11155111)");

  const state = existsSync(statePath) ? decodeState(readFileSync(statePath, "utf8")) : newState(network);
  const seeds = seedWallets(mnemonic);
  const wallets = Object.fromEntries(ROLES.map((r) => [r, seeds[r].address]));
  if (state.wallets && JSON.stringify(state.wallets) !== JSON.stringify(wallets)) throw new Error(`${statePath} was written for other seed wallets (a different SEED_MNEMONIC)`);
  const vaultErr = stateVaultError(state, d.cardVault);
  if (vaultErr) throw new Error(`${statePath}: ${vaultErr}`);
  state.vault = d.cardVault;
  state.wallets = wallets;
  const marketVault = await pub.readContract({ address: d.shardMarket, abi: abi.shardMarket, functionName: "vault" });
  if (marketVault.toLowerCase() !== d.cardVault.toLowerCase()) throw new Error(`ShardMarket ${d.shardMarket} serves vault ${marketVault}, not ${d.cardVault}`);
  const feeBps = BigInt(await pub.readContract({ address: d.cardVault, abi: abi.cardVault, functionName: "feeBps" }));
  state.plan ??= planScenario(markets, liveBlocks); // a resumed run keeps the prices and bids it started with
  state.fromBlock ??= String(await pub.getBlockNumber());
  const plan = state.plan;
  const b = budget(plan, feeBps);
  const cap = budgetCapError(b); // before any prompt, signature or fork funding
  if (cap) throw new Error(cap);

  const ctx: Ctx = {
    mode, network, pub, rpcUrl, d, state, statePath, signer,
    deployer: { role: "deployer", account: deployerAcc, address: deployerAcc.address },
    vendor: { role: "vendor", account: vendorAcc, address: vendorAcc.address },
    seeds, log: [], fees: 0n, gas: new Map(), resumed: false,
  };
  saveState(ctx);
  printPlan(cards, plan, b, seeds, feeBps);

  for (const r of ROLES) {
    const code = await pub.getCode({ address: seeds[r].address });
    if (code && code !== "0x") throw new Error(`${r} ${seeds[r].address} has code (an EIP-7702 delegation?); it could not receive its ENS handle`);
  }

  if (mode === "broadcast") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nThis sends real transactions on Sepolia from ${deployerAcc.address}, the vendor and six seed wallets.\nType BROADCAST to continue: `);
    rl.close();
    if (!isBroadcastConfirmation(answer)) {
      console.log("Not confirmed; nothing was sent.");
      return;
    }
  }

  // Deployer USDC: stop with the faucet link when short. On the fork the shortfall is dealt locally so the run goes on.
  // What the seed wallets still lack (a resumed run may have funded some already).
  let stillNeeded = 0n;
  for (const r of ROLES) stillNeeded += usdcTopUp(await usdcOf(ctx, seeds[r].address), b.perRole[r]);
  const have = await usdcOf(ctx, deployerAcc.address);
  const short = faucetMessage(deployerAcc.address, stillNeeded, have);
  if (short) {
    if (mode === "broadcast") throw new Error(short);
    console.log(`\n! ${short}\n  (fork only: dealing the shortfall to the deployer with anvil_dealERC20)`);
    await forkDealUsdc(ctx, deployerAcc.address, have + stillNeeded);
  }
  const payoutAddr = await read<Address>(ctx, d.cardVault, abi.cardVault, "payout");
  const payoutBefore = await usdcOf(ctx, payoutAddr);

  await fundWallets(ctx, b);
  await registerHandles(ctx);
  await approvePermit2(ctx, plan);
  const ids = await mintCards(ctx, cards);

  console.log("\nAuctions A, B, C: shard and bid");
  const sA = await shard(ctx, "A", ids.A, seeds[CARDS.A.owner], plan.auctions.A);
  const bidsA = await placeBids(ctx, "A", sA, plan.auctions.A);
  const sB = await shard(ctx, "B", ids.B, seeds[CARDS.B.owner], plan.auctions.B);
  const bidsB = await placeBids(ctx, "B", sB, plan.auctions.B);
  const sC = await shard(ctx, "C", ids.C, seeds[CARDS.C.owner], plan.auctions.C);
  const bidsC = await placeBids(ctx, "C", sC, plan.auctions.C);

  console.log("\nSettle");
  await waitForBlock(ctx, sA.endBlock);
  const setA = await settle(ctx, "A", ids.A, sA.token, seeds[CARDS.A.owner]);
  await waitForBlock(ctx, sB.endBlock);
  const setB = await settle(ctx, "B", ids.B, sB.token, seeds[CARDS.B.owner]);
  await waitForBlock(ctx, sC.endBlock);
  const setC = await settle(ctx, "C", ids.C, sC.token, seeds[CARDS.C.owner]);
  for (const s of [setA, setB, setC]) ctx.fees += s.fee;
  const poolA = await checkSeeding(ctx, "A", ids.A, sA, setA, seeds[CARDS.A.owner]);
  const poolB = await checkSeeding(ctx, "B", ids.B, sB, setB, seeds[CARDS.B.owner]);
  await checkSeeding(ctx, "C", ids.C, sC, setC, seeds[CARDS.C.owner]);
  if (!poolA || !poolB) throw new Error("cards A and B must graduate (and open pools) for the rest of the scenario");

  console.log("\nExit and claim");
  await exitAndClaim(ctx, "A", sA, setA, bidsA);
  await exitAndClaim(ctx, "B", sB, setB, bidsB);
  const exitsC = await exitAndClaim(ctx, "C", sC, setC, bidsC);

  await tradeB(ctx, ids.B, sB, poolB);

  await buyFromPool(ctx, sA, poolA, plan);
  const { price } = await redeemA(ctx, ids.A, sA, seeds[BUYER], plan, poolA);
  // The card's owner holds the shards the pool returned at unwind; any other auction winner holds its fill.
  const holdersA = [CARDS.A.owner, ...new Set(bidsA.map((x) => x.bidder).filter((r) => r !== BUYER))];
  if (!isStarted(ctx.state.steps[`payout-A-${CARDS.A.owner}`])) {
    const back = await shardsOf(ctx, sA.token, seeds[CARDS.A.owner].address);
    assert(back > 0n, `${HANDLES[CARDS.A.owner]} holds the ${shards(back)} shards returned from the pool`);
  }
  await claimPayouts(ctx, sA, price, holdersA);

  console.log("\nCard B: a holder sends 0.5 shards");
  const [fromB, toB] = [seeds.bidder0, seeds.bidder3];
  await step(ctx, "send-B", fromB, { address: sB.token, abi: abi.shardToken, functionName: "transfer", args: [toB.address, SHARD / 2n] }, {
    note: `${HANDLES.bidder0} → ${HANDLES.bidder3}`,
    // bidder3 also holds B shards (its bid, its pool buy), so look for this exact transfer rather than at the balance.
    skip: async () => {
      const sent = await findLogs(ctx, sB.token, abi.shardToken, "Transfer", { from: fromB.address, to: toB.address });
      return sent.some((l) => l.args.value === SHARD / 2n) ? "sent" : undefined;
    },
  });

  console.log("\nCard D: release at the counter");
  const holderD = await read<Address>(ctx, d.cardVault, abi.cardVault, "ownerOf", [ids.D]);
  const pass = passportTicket(holderD, await chainNow(ctx));
  const passSig = await signer.signTypedData({ domain: cardVaultDomain(d.cardVault), types: TICKET_TYPES, primaryType: "Ticket", message: pass });
  await step(ctx, "release-D", ctx.vendor, { address: d.cardVault, abi: abi.cardVault, functionName: "confirmRelease", args: [ids.D, pass, passSig] }, {
    note: `Passport ticket for ${HANDLES[CARDS.D.owner]}`,
    skip: async () => ((await cardOf(ctx, ids.D)).state === 4 ? "released" : undefined),
  });

  console.log(`\nCard A: re-shard as the live auction (${plan.liveBlocks} blocks)`);
  // The buyer redeemed card A, so it holds the NFT and shards it again.
  const sA2 = await shard(ctx, "A2", ids.A, seeds[BUYER], plan.auctions.A2, 1);
  await placeBids(ctx, "A2", sA2, plan.auctions.A2);

  console.log("\nAssertions (on chain)");
  const st = async (k: CardKey) => (await cardOf(ctx, ids[k])).state;
  assert((await st("A")) === 2, "card A is Auctioning (re-sharded, live)");
  assert((await st("B")) === 3 && setB.graduated, "card B is Sharded after a graduated auction");
  assert(!(await read<boolean>(ctx, d.shardMarket, abi.shardMarket, "isFrozen", [ids.B])), "card B's pool is open for trading");
  assert((await read<Hex>(ctx, d.shardMarket, abi.shardMarket, "poolIdOf", [ids.C])) === ZERO32, "card C has no pool");
  const shC = await shardingOf(ctx, sC.token);
  assert((await st("C")) === 3 && shC.settled && shC.graduated === false, "card C is Sharded and its auction did not graduate");
  assert((await shardsOf(ctx, sC.token, seeds[CARDS.C.owner].address)) === BigInt(TOTAL_SHARDS) * SHARD, "card C's owner holds all 16 shards again");
  for (const x of exitsC.filter((e) => e.fresh)) {
    assert(x.tokens === 0n && x.refund === x.bid.amount, `${HANDLES[x.bid.bidder]} got the card C bid (${usd(x.bid.amount)}) back in full`);
  }
  assert((await st("D")) === 4, "card D is Released");
  assert((await st("E")) === 1, "card E is Whole");
  assert((await shardsOf(ctx, sB.token, seeds.bidder3.address)) >= SHARD / 2n, `${HANDLES.bidder3} holds the 0.5 shards sent on card B`);
  // The chain is in its final state: record it before any check that could still fail.
  if (mode === "broadcast") writeManifest(ctx, cards, ids, { A: sA, B: sB, C: sC, A2: sA2 }, { A: poolA, B: poolB });
  const feesPaid = (await usdcOf(ctx, payoutAddr)) - payoutBefore;
  const feeMsg = `vault fees ${usd(ctx.fees)} (settle + buyout events) reached the payout address`;
  if (ctx.resumed) console.log("  (resumed run: the fee total is checked on a fresh run only)");
  else if (mode === "dry-run") assert(feesPaid === ctx.fees, feeMsg);
  else if (feesPaid === ctx.fees) console.log(`  ✓ ${feeMsg}`);
  else console.warn(`  ! WARNING: fee mismatch: the payout address gained ${usd(feesPaid)}, the events sum to ${usd(ctx.fees)} (did it receive USDC from elsewhere during the run?)`);

  if (mode === "dry-run") {
    // The demo settles the live auction on stage: on the fork, jump to its end and check that settle (which seeds card
    // A's second pool, after the first was unwound) would go through.
    console.log("\nDry run: the live auction can settle");
    await waitForBlock(ctx, sA2.endBlock);
    let err: string | null = null;
    await pub.simulateContract({ account: seeds[BUYER].account, address: d.cardVault, abi: abi.cardVault, functionName: "settle", args: [ids.A] }).catch((e) => (err = shortError(e)));
    assert(err === null, `settle(A) for the live auction simulates at block ${sA2.endBlock}${err ? `: ${err}` : ""}`);
  }

  if (mode === "broadcast") {
    console.log("\nAssertions (indexer)");
    await indexerChecks(ctx, ids, sC.token);
  }

  console.log("\nSummary");
  console.log(`  ${"step".padEnd(26)} tx`);
  for (const l of ctx.log) console.log(`  ${l.id.padEnd(26)} ${l.hash ? txUrl(network, l.hash) : "-"}`);
  const gas = [...ctx.gas.entries()].map(([r, v]) => `${r} ${formatEther(v)}`).join(", ");
  console.log(`\nGas spent (ETH): ${gas}`);
  console.log(`Cards: ${(Object.keys(ids) as CardKey[]).map((k) => `${k}=#${ids[k]}`).join(" ")}  live auction ${sA2.auction}`);
  if (mode === "dry-run") console.log("\nDRY RUN (fork) — nothing was broadcast");
  else console.log(`\nBROADCAST complete. State: ${statePath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e) => {
      const urls = [process.env.ALCHEMY_HTTP_URL, process.env.SEPOLIA_RPC_URL, process.env.NEXT_PUBLIC_ALCHEMY_HTTP_URL, process.env.PONDER_URL];
      console.error(`\n✗ ${redact(e instanceof Error ? e.message : String(e), urls)}`);
      process.exit(1);
    },
  );
}
