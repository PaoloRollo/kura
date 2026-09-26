import { describe, expect, it, vi } from "vitest";
import { keccak256, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TICKET_TYPES, bidGateDomain, q96ToUsdcPerShard } from "@kura/shared";
import {
  AUCTION_SHAPES,
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
    expect(() => parseArgs(["--dry-run", "--broadcast"])).toThrow();
    expect(() => parseArgs(["--live-blocks", "1"])).toThrow();
  });
});
