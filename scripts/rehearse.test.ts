import { describe, expect, it, vi } from "vitest";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TICKET_TYPES, bidGateDomain, q96ToUsdcPerShard } from "@kura/shared";
import {
  AUCTION_SHAPES,
  MIN_FLOOR_USDC,
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
const markets = { A: 2_620_000n, B: 2_850_000n, C: 1_930_000n, D: 440_000n, E: 2_480_000n };

describe("budget", () => {
  it("floors each card at its market price per shard, rounded down to a tick, never below the minimum", () => {
    expect(floorFor(2_620_000n)).toBe(160_000n); // 2.62 / 16 = 0.16375 → 0.16
    expect(floorFor(440_000n)).toBe(MIN_FLOOR_USDC); // 0.0275 → the 0.05 minimum
  });

  it("prices every bid at its max tick and sums the seed wallets' needs", () => {
    const plan = planScenario(markets, 7200);
    const b = budget(plan, 250n);
    const A = plan.auctions.A;
    // bidder0 bids on A (3 ticks, 1.2 shards) and B (4 ticks, 3 shards).
    const b0 = bidBudget(A.floorUsdc, TICK_USDC, A.bids[2]) + bidBudget(plan.auctions.B.floorUsdc, TICK_USDC, plan.auctions.B.bids[3]);
    expect(b.perRole.bidder0).toBe(b0);
    expect(b.perRole.owner1).toBe(0n);
    // The buyout bound: 3 shards at max(top A bid, appraisal) plus the 2.5% fee, rounded up by one unit.
    const top = q96ToUsdcPerShard(bidMaxQ96(A.floorUsdc, TICK_USDC, 3));
    const payout = top * 3n;
    expect(b.buyoutUsdc).toBe(payout + (payout * 250n) / 10_000n + 1n);
    expect(b.perRole.owner0).toBe(b.buyoutUsdc);
    expect(b.totalUsdc).toBe(Object.values(b.perRole).reduce((x, y) => x + y, 0n));
    // Cheap cards keep the whole run inside one faucet request.
    expect(b.totalUsdc).toBeLessThan(10n * U);
  });

  it("keeps the card A owner above the 80% rule and the card C reserve above every bid", () => {
    expect((16 - AUCTION_SHAPES.A.forSale) * 5).toBeGreaterThanOrEqual(16 * 4);
    const plan = planScenario(markets, 7200);
    const bidsC = plan.auctions.C.bids.reduce((a, x) => a + bidBudget(plan.auctions.C.floorUsdc, TICK_USDC, x), 0n);
    expect(plan.auctions.C.reserveUsdc).toBeGreaterThan(bidsC);
    expect(plan.auctions.A2.durationBlocks).toBe(7200);
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
  const H1 = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
  const H2 = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;

  it("skips a finished step without touching the chain", async () => {
    const s = newState("sepolia");
    s.steps.mint = { status: "done", hash: H1, out: "7" };
    const send = vi.fn();
    const wait = vi.fn();
    const r = await runStep(s, "mint", { send, wait, save: () => {} });
    expect(r).toEqual({ out: "7", hash: H1, fresh: false });
    expect(send).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("a hash without a receipt is waited for, never sent again", async () => {
    const s = newState("sepolia");
    s.steps.bid = { status: "sent", hash: H1 };
    const send = vi.fn(async () => H2);
    const skip = vi.fn(async () => "on chain");
    const wait = vi.fn(async (h: Hex) => ok(h));
    const r = await runStep(s, "bid", { send, skip, wait, parse: () => "id-3", save: () => {} });
    expect(send).not.toHaveBeenCalled();
    expect(skip).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledWith(H1);
    expect(r.fresh).toBe(true);
    expect(s.steps.bid).toEqual({ status: "done", hash: H1, out: "id-3", failed: undefined });
  });

  it("records the hash before waiting, so a crash mid-wait resumes by waiting", async () => {
    const saved: RehearseState[] = [];
    const s = newState("sepolia");
    const wait = vi.fn(async (h: Hex) => {
      expect(saved.at(-1)?.steps.settle).toEqual({ status: "sent", hash: H1, failed: undefined });
      return ok(h);
    });
    await runStep(s, "settle", { send: async () => H1, wait, save: (x) => saved.push(structuredClone(x)) });
    expect(wait).toHaveBeenCalledOnce();
    expect(s.steps.settle.status).toBe("done");
  });

  it("marks a step skipped when its effect is already on chain", async () => {
    const s = newState("sepolia");
    const send = vi.fn(async () => H1);
    const r = await runStep(s, "handle", { skip: async () => "seedaiko", send, wait: async (h) => ok(h), save: () => {} });
    expect(send).not.toHaveBeenCalled();
    expect(r.out).toBe("seedaiko");
    expect(s.steps.handle.status).toBe("skipped");
  });

  it("a reverted step is cleared and sent afresh on the next run", async () => {
    const s = newState("sepolia");
    await expect(runStep(s, "redeem", { send: async () => H1, wait: async (h) => ({ ...ok(h), status: "reverted" as const }), save: () => {} })).rejects.toThrow(/reverted/);
    expect(s.steps.redeem).toEqual({ status: "failed", failed: [H1] });
    const send = vi.fn(async () => H2);
    await runStep(s, "redeem", { send, wait: async (h) => ok(h), save: () => {} });
    expect(send).toHaveBeenCalledOnce();
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
    expect(() => parseArgs(["--dry-run", "--broadcast"])).toThrow();
    expect(() => parseArgs(["--live-blocks", "1"])).toThrow();
  });
});
