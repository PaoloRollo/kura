import { describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, keccak256, parseAbiParameters, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TICKET_TYPES, bidGateDomain, q96ToUsdcPerShard, type PoolKey } from "@kura/shared";
import {
  AUCTION_SHAPES,
  BUYER,
  FOR_SALE,
  handleStatus,
  TRADES_B,
  buyoutEstimate,
  minOut,
  redeemTarget,
  shardParams,
  stateVaultError,
  statePathFor,
  swapExecuteArgs,
  swapSignsOk,
  MAX_TOTAL_ETH,
  MAX_TOTAL_USDC,
  budgetCapError,
  redact,
  isKnownTxError,
  txHashOf,
  MIN_FLOOR_USDC,
  REFUSED_LOOKUPS,
  REFUSED_LOOKUP_MS,
  TICK_USDC,
  bidBudget,
  bidMaxQ96,
  broadcastRefusal,
  budget,
  decodeState,
  encodeState,
  ethTopUp,
  faucetMessage,
  floorFor,
  humanTicket,
  isBroadcastConfirmation,
  newState,
  parseArgs,
  passportTicket,
  planScenario,
  runStep,
  seedNullifier,
  usdcTopUp,
  type ReceiptLike,
  type RehearseState,
} from "./rehearse";

const U = 10n ** 6n;
const SHARD = 10n ** 18n;
const markets = { A: 2_620_000n, B: 2_850_000n, C: 1_930_000n, D: 440_000n, E: 2_480_000n };

describe("budget", () => {
  it("floors each card at its market price per shard, rounded down to a tick, never below the minimum", () => {
    expect(floorFor(2_620_000n)).toBe(160_000n); // 2.62 / 16 = 0.16375 → 0.16
    expect(floorFor(440_000n)).toBe(MIN_FLOOR_USDC); // 0.0275 → the 0.05 minimum
  });

  it("prices every bid at its max tick and sums the seed wallets' needs", () => {
    const plan = planScenario(markets, 7200);
    const b = budget(plan, 250n);
    const B = plan.auctions.B;
    // bidder1 bids on B (3 ticks, 2 shards) and sells shards on the B pool (no USDC).
    expect(b.perRole.bidder1).toBe(bidBudget(B.floorUsdc, TICK_USDC, B.bids[2]));
    // bidder3 bids on B, C and A2 and buys on the B pool with 0.10 USDC.
    const b3 = [plan.auctions.B.bids[0], plan.auctions.C.bids[0], plan.auctions.A2.bids[0]];
    const auctions3 = [plan.auctions.B, plan.auctions.C, plan.auctions.A2];
    const bids3 = b3.reduce((a, x, i) => a + bidBudget(auctions3[i].floorUsdc, TICK_USDC, x), 0n);
    expect(b.perRole.bidder3).toBe(bids3 + TRADES_B.find((t) => t.role === "bidder3")!.amount);
    // The owners only pay gas: their shards and the proceeds seed the pools.
    expect(b.perRole.owner0).toBe(0n);
    expect(b.perRole.owner1).toBe(0n);
    expect(b.totalUsdc).toBe(Object.values(b.perRole).reduce((x, y) => x + y, 0n));
    // Cheap cards keep the whole run inside one faucet request.
    expect(b.totalUsdc).toBeLessThan(10n * U);
  });

  it("the buyer bids on A, then buys from the pool and redeems; its budget covers all three", () => {
    const plan = planScenario(markets, 7200);
    const b = budget(plan, 250n);
    const A = plan.auctions.A;
    const buyerBid = A.bids.find((x) => x.bidder === BUYER)!;
    const est = buyoutEstimate(plan, 250n);
    const bidsElsewhere = plan.auctions.B.bids.filter((x) => x.bidder === BUYER).reduce((a, x) => a + bidBudget(plan.auctions.B.floorUsdc, TICK_USDC, x), 0n);
    expect(b.perRole[BUYER]).toBe(bidBudget(A.floorUsdc, TICK_USDC, buyerBid) + bidsElsewhere + est.poolBuyUsdc + est.redeemUsdc);
    expect(b.buyoutUsdc).toBe(est.poolBuyUsdc + est.redeemUsdc);
  });

  it("estimates the pool buy with the constant-product formula, the pool fee and a margin", () => {
    const plan = planScenario(markets, 7200);
    const est = buyoutEstimate(plan, 250n);
    const M = q96ToUsdcPerShard(bidMaxQ96(plan.auctions.A.floorUsdc, TICK_USDC, plan.auctions.A.bids[0].ticks));
    expect(est.clearingUsdc).toBe(M);
    // The buyer fills the whole sale half at best; 80% of 16 is 12.8, so 4.8 more come from the pool.
    expect(est.fillShards).toBe(8n * SHARD);
    expect(est.needShards).toBe(4_800_000_000_000_000_000n);
    // Full range: the fee-reduced USDC at price M funds 8 × 0.975 = 7.8 shards.
    expect(est.poolShards).toBe(7_800_000_000_000_000_000n);
    const raw = (M * 78n * 48n) / (10n * 30n); // M · 7.8 · 4.8 / (7.8 − 4.8)
    expect(est.poolBuyUsdc).toBeGreaterThanOrEqual((raw * 150n) / 100n);
    expect(est.poolBuyUsdc).toBeLessThan((raw * 153n) / 100n);
    // Redeem: 3.2 shards not held, at max(clearing, appraisal), plus the 2.5% fee.
    const appraisal = markets.A / 16n;
    const price = M > appraisal ? M : appraisal;
    const payout = (price * 32n) / 10n;
    expect(est.redeemUsdc).toBe(payout + (payout * 250n) / 10_000n + 1n);
  });

  it("refuses a plan whose pool couldn't supply the buyout", () => {
    const plan = planScenario(markets, 7200);
    plan.auctions.A = { ...plan.auctions.A, bids: [{ bidder: BUYER, ticks: 1, shardsX10: 20 }] };
    expect(() => buyoutEstimate(plan, 250n)).toThrow(/pool/);
  });

  it("keeps the card C reserve above every bid, and the live auction's duration", () => {
    const plan = planScenario(markets, 7200);
    const bidsC = plan.auctions.C.bids.reduce((a, x) => a + bidBudget(plan.auctions.C.floorUsdc, TICK_USDC, x), 0n);
    expect(plan.auctions.C.reserveUsdc).toBeGreaterThan(bidsC);
    expect(plan.auctions.A2.durationBlocks).toBe(7200);
  });

  it("sends the new ShardParams tuple: no forSale, half the shards are always auctioned", () => {
    const plan = planScenario(markets, 7200);
    const p = shardParams(plan.auctions.B);
    expect(p).toEqual({ totalShards: 16, floorUsdcPerShard: plan.auctions.B.floorUsdc, tickUsdcPerShard: TICK_USDC, reserveUsdc: 0n, durationBlocks: 30 });
    expect("forSale" in p).toBe(false);
    expect(FOR_SALE).toBe(8);
    for (const a of Object.values(AUCTION_SHAPES)) expect("forSale" in a).toBe(false);
  });

  it("each wallet's ETH floor (half its target) covers twice the gas it spent in the dry run at ~1 gwei", () => {
    const b = budget(planScenario(markets, 7200), 250n);
    // Measured on an anvil fork of Sepolia, 2026-09-26 (Gas spent summary), in ETH × 1e6.
    const spent = { owner0: 12_919n, owner1: 7_229n, bidder0: 7_475n, bidder1: 880n, bidder2: 1_381n, bidder3: 2_151n, vendor: 7_551n };
    for (const [role, micro] of Object.entries(spent)) {
      expect(b.ethTarget[role as keyof typeof spent] / 2n, role).toBeGreaterThanOrEqual(micro * 10n ** 12n * 2n);
    }
  });

  it("tops up only below half the target, and says where to get USDC when the deployer is short", () => {
    expect(ethTopUp(6n, 10n)).toBe(0n);
    expect(ethTopUp(4n, 10n)).toBe(6n);
    expect(usdcTopUp(5n, 3n)).toBe(0n);
    expect(usdcTopUp(1n, 3n)).toBe(2n);
    const deployer = "0xDeADaD159DF0923dAF871f8B4740eD7f7F417ee9";
    expect(faucetMessage(deployer, 3n * U, 3n * U)).toBeNull();
    expect(faucetMessage(deployer, 3_500_000n, 0n)).toBe(`Top up ${deployer} at https://faucet.circle.com (Ethereum Sepolia, USDC). Need 3.5, have 0`);
  });
});

describe("resumable steps", () => {
  const ok = (hash: Hex): ReceiptLike => ({ status: "success", blockNumber: 1n, transactionHash: hash });
  const RAW1 = "0x02f86b0101" as Hex;
  const RAW2 = "0x02f86b0102" as Hex;
  const H1 = keccak256(RAW1);
  const H2 = keccak256(RAW2);
  const io = (over: Partial<Parameters<typeof runStep>[2]> = {}) => ({
    sign: vi.fn(async () => RAW1),
    broadcast: vi.fn(async (_raw: Hex): Promise<unknown> => undefined),
    wait: vi.fn(async (h: Hex): Promise<ReceiptLike | null> => ok(h)),
    receipt: vi.fn(async (_h: Hex): Promise<ReceiptLike | null> => null),
    lookup: vi.fn(async (_h: Hex) => true),
    nonceUsed: vi.fn(async (_raw: Hex) => false),
    sleep: vi.fn(async (_ms: number) => {}),
    save: vi.fn(),
    ...over,
  });
  const sent = () => {
    const s = newState("sepolia");
    s.steps.bid = { status: "sent", hash: H1, raw: RAW1 };
    return s;
  };

  it("skips a finished step without touching the chain", async () => {
    const s = newState("sepolia");
    s.steps.mint = { status: "done", hash: H1, out: "7" };
    const x = io();
    const r = await runStep(s, "mint", x);
    expect(r).toEqual({ out: "7", hash: H1, fresh: false });
    expect(x.sign).not.toHaveBeenCalled();
    expect(x.broadcast).not.toHaveBeenCalled();
    expect(x.wait).not.toHaveBeenCalled();
  });

  it("saves the hash and the raw tx as sent before broadcasting", async () => {
    const order: string[] = [];
    const saved: RehearseState[] = [];
    const s = newState("sepolia");
    await runStep(s, "settle", io({
      sign: vi.fn(async () => { order.push("sign"); return RAW1; }),
      save: vi.fn((x: RehearseState) => { order.push(`save:${x.steps.settle.status}`); saved.push(structuredClone(x)); }),
      broadcast: vi.fn(async () => { order.push("broadcast"); }),
      wait: vi.fn(async (h: Hex) => { order.push("wait"); return ok(h); }),
    }));
    expect(order).toEqual(["sign", "save:sent", "broadcast", "wait", "save:done"]);
    expect(saved[0].steps.settle).toEqual({ status: "sent", hash: H1, raw: RAW1, failed: undefined });
    expect(txHashOf(RAW1)).toBe(H1);
  });

  it("fresh: a tx the node refuses and doesn't know fails the step with the node's reason", async () => {
    const s = newState("sepolia");
    const sleep = vi.fn(async (_ms: number) => {});
    const x = io({ broadcast: vi.fn(async () => { throw new Error("insufficient funds for gas * price + value"); }), lookup: vi.fn(async () => false), sleep });
    await expect(runStep(s, "bid", x)).rejects.toThrow(/refused .*insufficient funds/);
    expect(s.steps.bid).toEqual({ status: "failed", failed: [H1] });
    expect(x.wait).not.toHaveBeenCalled();
    // It looked the hash up REFUSED_LOOKUPS times, REFUSED_LOOKUP_MS apart (~15 s), before failing.
    expect(x.lookup).toHaveBeenCalledTimes(REFUSED_LOOKUPS);
    expect(sleep.mock.calls).toEqual(Array.from({ length: REFUSED_LOOKUPS - 1 }, () => [REFUSED_LOOKUP_MS]));
    expect(REFUSED_LOOKUPS * REFUSED_LOOKUP_MS).toBe(15_000);
  });

  it("fresh: a refused tx that shows up on a later lookup is waited for, not failed", async () => {
    const s = newState("sepolia");
    const lookup = vi.fn(async (_h: Hex) => false).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const x = io({ broadcast: vi.fn(async () => { throw new Error("nonce too low"); }), lookup });
    const r = await runStep(s, "bid", x);
    expect(r.hash).toBe(H1);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(s.steps.bid.status).toBe("done");
  });

  it("failed: refuses to re-sign while the sender has a tx in flight, and re-signs once it cleared", async () => {
    const s = newState("sepolia");
    s.steps.bid = { status: "failed", failed: [H1] };
    const busy = io({ sign: vi.fn(async () => RAW2), nonces: vi.fn(async () => ({ pending: 8, latest: 7 })) });
    await expect(runStep(s, "bid", busy)).rejects.toThrow(/not re-signing .*1 transaction in flight \(pending nonce 8 > latest 7\)/);
    expect(busy.sign).not.toHaveBeenCalled();
    expect(busy.broadcast).not.toHaveBeenCalled();
    // The state is untouched, so the file format and the failed history stay as they were.
    expect(s.steps.bid).toEqual({ status: "failed", failed: [H1] });
    const clear = io({ sign: vi.fn(async () => RAW2), nonces: vi.fn(async () => ({ pending: 8, latest: 8 })) });
    await runStep(s, "bid", clear);
    expect(clear.sign).toHaveBeenCalledOnce();
    expect(s.steps.bid).toEqual({ status: "done", hash: H2, out: null, failed: [H1] });
  });

  it("a new step signs without the in-flight check (a nonce gap only matters for a step that failed)", async () => {
    const s = newState("sepolia");
    const x = io({ nonces: vi.fn(async () => ({ pending: 9, latest: 7 })) });
    await runStep(s, "bid", x);
    expect(x.nonces).not.toHaveBeenCalled();
    expect(s.steps.bid.status).toBe("done");
  });

  it("fresh: a broadcast error for a tx the node has anyway is just waited for", async () => {
    const s = newState("sepolia");
    const x = io({ broadcast: vi.fn(async () => { throw new Error("socket hang up"); }), lookup: vi.fn(async () => true) });
    const r = await runStep(s, "bid", x);
    expect(r.hash).toBe(H1);
    expect(s.steps.bid.status).toBe("done");
  });

  it("resume: a hash the node doesn't know is re-broadcast at once, the same raw tx, never re-signed", async () => {
    const s = sent();
    const order: string[] = [];
    const x = io({
      lookup: vi.fn(async () => false),
      broadcast: vi.fn(async (raw: Hex) => { order.push(`broadcast:${raw}`); }),
      wait: vi.fn(async (h: Hex) => { order.push("wait"); return ok(h); }),
      sign: vi.fn(async () => RAW2),
    });
    const r = await runStep(s, "bid", x);
    expect(order).toEqual([`broadcast:${RAW1}`, "wait"]);
    expect(x.sign).not.toHaveBeenCalled();
    expect(r.hash).toBe(H1);
  });

  it("resume: a known hash with a receipt is only awaited", async () => {
    const s = sent();
    const skip = vi.fn(async () => "on chain");
    const x = io({ skip, parse: () => "id-3" });
    const r = await runStep(s, "bid", x);
    expect(x.sign).not.toHaveBeenCalled();
    expect(x.broadcast).not.toHaveBeenCalled();
    expect(skip).not.toHaveBeenCalled();
    expect(r.fresh).toBe(true);
    expect(s.steps.bid).toEqual({ status: "done", hash: H1, out: "id-3", failed: undefined });
  });

  it("not mined and its nonce used elsewhere, with the effect on chain: skipped", async () => {
    const s = sent();
    const x = io({ wait: vi.fn(async () => null), nonceUsed: vi.fn(async () => true), skip: vi.fn(async () => "12") });
    const r = await runStep(s, "bid", x);
    expect(r).toEqual({ out: "12", fresh: false });
    expect(s.steps.bid.status).toBe("skipped");
    expect(x.broadcast).not.toHaveBeenCalled();
  });

  it("not mined and its nonce used elsewhere, no effect on chain: failed, so the next run re-signs", async () => {
    const s = sent();
    const x = io({ wait: vi.fn(async () => null), nonceUsed: vi.fn(async () => true) });
    await expect(runStep(s, "bid", x)).rejects.toThrow(/nonce was used by another transaction/);
    expect(s.steps.bid).toEqual({ status: "failed", failed: [H1] });
    const y = io({ sign: vi.fn(async () => RAW2) });
    await runStep(s, "bid", y);
    expect(y.sign).toHaveBeenCalledOnce();
    expect(s.steps.bid.hash).toBe(H2);
  });

  it("the nonce moved because this very tx landed: its receipt is used", async () => {
    const s = sent();
    const x = io({ wait: vi.fn(async () => null), nonceUsed: vi.fn(async () => true), receipt: vi.fn(async (h: Hex) => ok(h)) });
    const r = await runStep(s, "bid", x);
    expect(r.fresh).toBe(true);
    expect(s.steps.bid.status).toBe("done");
  });

  it("not mined, nonce free: re-broadcasts (already known is fine) and waits once more", async () => {
    const s = sent();
    const wait = vi.fn<(h: Hex) => Promise<ReceiptLike | null>>().mockResolvedValueOnce(null).mockImplementation(async (h) => ok(h));
    const x = io({ wait, broadcast: vi.fn(async () => { throw new Error("already known"); }) });
    const r = await runStep(s, "bid", x);
    expect(x.broadcast).toHaveBeenCalledExactlyOnceWith(RAW1);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(r.hash).toBe(H1);
  });

  it("not mined, nonce free, and the node now refuses it as underpriced: failed", async () => {
    const s = sent();
    const x = io({ wait: vi.fn(async () => null), broadcast: vi.fn(async () => { throw new Error("replacement transaction underpriced"); }) });
    await expect(runStep(s, "bid", x)).rejects.toThrow(/refused .*underpriced/);
    expect(s.steps.bid).toEqual({ status: "failed", failed: [H1] });
  });

  it("still pending after the second wait: stays sent, with a recovery hint", async () => {
    const s = sent();
    const x = io({ wait: vi.fn(async () => null) });
    await expect(runStep(s, "bid", x)).rejects.toThrow(/not mined yet.*check 0x[0-9a-f]{64} on Etherscan; don't use the seed\/vendor\/deployer keys/);
    expect(s.steps.bid.status).toBe("sent");
    expect(x.broadcast).toHaveBeenCalledOnce();
  });

  it("marks a step skipped when its effect is already on chain", async () => {
    const s = newState("sepolia");
    const x = io({ skip: async () => "seedaiko" });
    const r = await runStep(s, "handle", x);
    expect(x.sign).not.toHaveBeenCalled();
    expect(r.out).toBe("seedaiko");
    expect(s.steps.handle.status).toBe("skipped");
  });

  it("a reverted step is marked failed and signed afresh on the next run", async () => {
    const s = newState("sepolia");
    await expect(runStep(s, "redeem", io({ wait: async (h: Hex) => ({ ...ok(h), status: "reverted" as const }) }))).rejects.toThrow(/reverted/);
    expect(s.steps.redeem).toEqual({ status: "failed", failed: [H1] });
    const x = io({ sign: vi.fn(async () => RAW2) });
    await runStep(s, "redeem", x);
    expect(x.sign).toHaveBeenCalledOnce();
    expect(s.steps.redeem).toEqual({ status: "done", hash: H2, out: null, failed: [H1] });
  });

  it("round-trips bigints through the state file", () => {
    const s = newState("sepolia");
    s.plan = planScenario(markets, 25);
    s.steps.x = { status: "done", hash: H1, out: { n: "1" } };
    const back = decodeState(encodeState(s));
    expect(back).toEqual(s);
    expect(back.plan!.auctions.C.reserveUsdc).toBe(5n * U);
  });

  it("only 'already known' counts as a harmless re-broadcast error", () => {
    expect(isKnownTxError(new Error("already known"))).toBe(true);
    expect(isKnownTxError(new Error("known transaction: 0xabc"))).toBe(true);
    expect(isKnownTxError(new Error("nonce too low"))).toBe(false);
    expect(isKnownTxError(new Error("insufficient funds"))).toBe(false);
  });
});

describe("pool trades", () => {
  const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
  const LOW = "0x0000000000000000000000000000000000001234" as Address;
  const HIGH = "0xfFFfFfFffFFfFFFffFFffffFfFFfFfFfffff0001" as Address;
  const HOOK = "0x00000000000000000000000000000000000020C0" as Address;
  const keyOf = (shard: Address): PoolKey => {
    const s0 = BigInt(shard) < BigInt(USDC);
    return { currency0: s0 ? shard : USDC, currency1: s0 ? USDC : shard, fee: 10000, tickSpacing: 200, hooks: HOOK };
  };
  const decodeSwap = (inputs: Hex[]) => {
    const [, params] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), inputs[0]!);
    const [swap] = decodeAbiParameters(parseAbiParameters("((address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)"), params[0]!);
    const [currencyIn] = decodeAbiParameters(parseAbiParameters("address,uint256"), params[1]!);
    return { ...swap, currencyIn };
  };

  it.each([
    ["shard below USDC", LOW, true],
    ["shard above USDC", HIGH, false],
  ] as const)("buying spends USDC and selling spends shards (%s)", (_label, shard, shardIsCurrency0) => {
    const key = keyOf(shard);
    const [cmds, buyInputs, deadline] = swapExecuteArgs(key, shardIsCurrency0, "buy", 100_000n, 5n, 99n);
    expect(cmds).toBe("0x10");
    expect(deadline).toBe(99n);
    const buy = decodeSwap(buyInputs);
    expect(buy.currencyIn).toBe(USDC);
    expect(buy.zeroForOne).toBe(!shardIsCurrency0);
    expect(buy.amountIn).toBe(100_000n);
    expect(buy.amountOutMinimum).toBe(5n);
    const sell = decodeSwap(swapExecuteArgs(key, shardIsCurrency0, "sell", SHARD, 1n, 99n)[1]);
    expect(sell.currencyIn).toBe(shard);
    expect(sell.zeroForOne).toBe(shardIsCurrency0);
  });

  it("applies 1% slippage to the quote by default", () => {
    expect(minOut(1_000_000n)).toBe(990_000n);
    expect(minOut(1_000_000n, 0n)).toBe(1_000_000n);
    expect(minOut(0n)).toBe(0n);
  });

  it("checks the ShardSwap signs from the trader's side", () => {
    expect(swapSignsOk("buy", 100n, 5n, -100n)).toBe(true);
    expect(swapSignsOk("buy", 100n, -5n, 100n)).toBe(false);
    expect(swapSignsOk("buy", 100n, 5n, -99n)).toBe(false);
    expect(swapSignsOk("sell", 100n, -100n, 7n)).toBe(true);
    expect(swapSignsOk("sell", 100n, 100n, -7n)).toBe(false);
    expect(swapSignsOk("sell", 100n, -100n, 0n)).toBe(false);
  });

  it("the redeem target is the smallest balance the vault's 80% rule accepts", () => {
    for (const supply of [16n * SHARD, 16n * SHARD + 3n, 7n, 5n, 1n]) {
      const t = redeemTarget(supply);
      expect(t * 5n >= supply * 4n).toBe(true);
      expect((t - 1n) * 5n >= supply * 4n).toBe(false);
    }
  });

  it("B's trades: two buys and one sell by different seed wallets", () => {
    expect(TRADES_B.filter((t) => t.side === "buy")).toHaveLength(2);
    expect(TRADES_B.filter((t) => t.side === "sell")).toHaveLength(1);
    expect(new Set(TRADES_B.map((t) => t.role)).size).toBe(3);
    expect(TRADES_B.every((t) => t.role !== BUYER)).toBe(true);
  });
});

describe("state file", () => {
  const vault = "0xEC598d41513A15Bb17D4FAeF5e127aB47A54f1B4" as Address;
  it("is keyed by network and vault, so a redeploy starts a fresh file", () => {
    expect(statePathFor("/r", "sepolia", vault)).toBe("/r/scripts/.rehearse-state.sepolia.0xec598d41513a15bb17d4faef5e127ab47a54f1b4.json");
    expect(statePathFor("/r", "fork", vault)).toMatch(/\.rehearse-state\.fork\./);
  });
  it("refuses to resume a state recorded for another vault", () => {
    const s = newState("sepolia");
    expect(stateVaultError(s, vault)).toBeNull();
    s.vault = vault;
    expect(stateVaultError(s, vault.toLowerCase() as Address)).toBeNull();
    expect(stateVaultError(s, "0x0000000000000000000000000000000000000001")).toMatch(/other vault/);
  });
});

describe("ENS names across redeploys", () => {
  const me = "0x87cf087eaBE98eA401F3098637bf18C6F3ead7dA" as Address;
  const other = "0x0000000000000000000000000000000000000001" as Address;
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  it("a handle recorded by this CardNames is done; a free one is registered", () => {
    expect(handleStatus({ recorded: "seedaiko", available: false, ensOwner: me, wallet: me })).toBe("recorded");
    expect(handleStatus({ recorded: "", available: true, ensOwner: zero, wallet: me })).toBe("register");
  });
  it("a handle this wallet still owns from an earlier deployment counts as done; anyone else's is a conflict", () => {
    expect(handleStatus({ recorded: "", available: false, ensOwner: me.toLowerCase() as Address, wallet: me })).toBe("owned");
    expect(handleStatus({ recorded: "", available: false, ensOwner: other, wallet: me })).toBe("taken");
  });
});

describe("caps and redaction", () => {
  it("refuses a plan above 10 USDC or the ETH cap", () => {
    const b = budget(planScenario(markets, 7200), 250n);
    expect(budgetCapError(b)).toBeNull();
    expect(budgetCapError({ ...b, totalUsdc: MAX_TOTAL_USDC + 1n })).toMatch(/above the 10 USDC cap/);
    expect(budgetCapError({ ...b, ethTarget: { ...b.ethTarget, vendor: MAX_TOTAL_ETH } })).toMatch(/ETH cap/);
  });

  it("hides RPC keys in printed errors", () => {
    const url = "https://eth-sepolia.g.alchemy.com/v2/abcDEF123456789xyz";
    const msg = `HTTP request failed.\nURL: ${url}\nRequest body: {}`;
    expect(redact(msg, [url])).toBe("HTTP request failed.\nURL: https://eth-sepolia.g.alchemy.com/<redacted>\nRequest body: {}");
    expect(redact("wss://eth-sepolia.g.alchemy.com/v2/abcDEF123456789xyz")).toBe("wss://eth-sepolia.g.alchemy.com/v2/<redacted>");
    expect(redact("URL: http://127.0.0.1:8546")).toBe("URL: http://127.0.0.1:8546");
  });
});

describe("tickets", () => {
  const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const bidder = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

  it("builds a HUMAN ticket for the bidder with a synthetic nullifier and a short expiry", async () => {
    const t = humanTicket(bidder, 1_000n);
    expect(t).toEqual({ kind: 1, subject: bidder, nullifier: seedNullifier(bidder), expiresAt: 1_000n + 3600n });
    expect(seedNullifier(bidder)).toBe(seedNullifier(bidder.toLowerCase() as typeof bidder));
    const hook = "0x572E7C7001Cc48fB18015325cF97F660056adA7E";
    const sig = await signer.signTypedData({ domain: bidGateDomain(hook), types: TICKET_TYPES, primaryType: "Ticket", message: t });
    expect(await recoverTypedDataAddress({ domain: bidGateDomain(hook), types: TICKET_TYPES, primaryType: "Ticket", message: t, signature: sig })).toBe(signer.address);
  });

  it("builds a single-use PASSPORT ticket naming the holder", () => {
    const a = passportTicket(bidder, 1_000n);
    expect(a.kind).toBe(2);
    expect(a.subject).toBe(bidder);
    expect(a.expiresAt).toBe(1_900n);
    expect(passportTicket(bidder, 1_001n).nullifier).not.toBe(a.nullifier);
  });
});

describe("broadcast guard", () => {
  it("refuses without a TTY or in CI", () => {
    expect(broadcastRefusal({ isTTY: false, ci: undefined })).toMatch(/interactive terminal/);
    expect(broadcastRefusal({ isTTY: undefined, ci: undefined })).toMatch(/interactive terminal/);
    expect(broadcastRefusal({ isTTY: true, ci: "true" })).toMatch(/CI/);
    expect(broadcastRefusal({ isTTY: true, ci: "1" })).toMatch(/CI/);
    expect(broadcastRefusal({ isTTY: true, ci: undefined })).toBeNull();
    expect(broadcastRefusal({ isTTY: true, ci: "false" })).toBeNull();
  });

  it("needs the exact word BROADCAST", () => {
    expect(isBroadcastConfirmation("BROADCAST")).toBe(true);
    expect(isBroadcastConfirmation("  BROADCAST\n")).toBe(true);
    expect(isBroadcastConfirmation("broadcast")).toBe(false);
    expect(isBroadcastConfirmation("y")).toBe(false);
    expect(isBroadcastConfirmation("")).toBe(false);
  });

  it("never broadcasts by default", () => {
    expect(parseArgs([]).mode).toBe("plan");
    expect(parseArgs(["--dry-run"]).mode).toBe("dry-run");
    expect(parseArgs(["--broadcast", "--live-blocks", "300"])).toEqual({ mode: "broadcast", liveBlocks: 300 });
    expect(parseArgs(["--dry-run", "--fork-url", "http://127.0.0.1:8547", "--deployments", "contracts/deployments/tmp/sepolia.json"])).toEqual({
      mode: "dry-run", liveBlocks: 7200, forkUrl: "http://127.0.0.1:8547", deployments: "contracts/deployments/tmp/sepolia.json",
    });
    // A broadcast always uses the committed deployments and the configured RPC.
    expect(() => parseArgs(["--broadcast", "--deployments", "x.json"])).toThrow(/--dry-run/);
    expect(() => parseArgs(["--broadcast", "--fork-url", "http://127.0.0.1:8547"])).toThrow(/--dry-run/);
    expect(() => parseArgs(["--dry-run", "--fork-url"])).toThrow();
    expect(() => parseArgs(["--dry-run", "--broadcast"])).toThrow();
    expect(() => parseArgs(["--live-blocks", "1"])).toThrow();
  });
});
