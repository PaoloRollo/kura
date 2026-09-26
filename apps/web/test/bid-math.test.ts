import { describe, expect, it } from "vitest";
import { q96ToUsdcPerShard, usdcPerShardToQ96 } from "@kura/shared";
import {
  bidRevertMessage,
  bidView,
  defaultMaxPriceQ96,
  demandRatio,
  endedNowPreview,
  estimateShards,
  exitRoute,
  isRetryableBidError,
  isValidMax,
  maxQ96FromUsdc,
  roundDownToTick,
} from "@/lib/bid-math";

describe("bid math", () => {
  it("estimates fractional shards from a budget", () => {
    expect(estimateShards(20_000_000n, 11_000_000n)).toBe(1_818181818181818181n);
    expect(estimateShards(10_000_000n, 10_000_000n)).toBe(10n ** 18n);
  });
  it("defaults to clearing plus two ticks and rounds to ticks", () => {
    const tick = usdcPerShardToQ96(500_000n);
    const clearing = tick * 20n;
    expect(defaultMaxPriceQ96(clearing, tick)).toBe(tick * 22n);
    expect(roundDownToTick(tick * 22n + 5n, tick)).toBe(tick * 22n);
    expect(isValidMax(tick * 21n, clearing, tick)).toBe(true);
    expect(isValidMax(tick * 20n, clearing, tick)).toBe(false);
    expect(isValidMax(tick * 21n + 1n, clearing, tick)).toBe(false);
  });
  it("treats a zero tick as no valid price instead of dividing by zero", () => {
    expect(roundDownToTick(123n, 0n)).toBe(0n);
    expect(isValidMax(123n, 100n, 0n)).toBe(false);
    expect(defaultMaxPriceQ96(100n, 0n)).toBe(0n);
  });
  it("maps a typed USDC max onto its own tick, not one below", () => {
    const tick = usdcPerShardToQ96(20_000_000n);
    expect(maxQ96FromUsdc(1_760_000_000n, tick)).toBe(tick * 88n);
    expect(q96ToUsdcPerShard(maxQ96FromUsdc(1_760_000_000n, tick))).toBe(1_760_000_000n);
    expect(maxQ96FromUsdc(1_775_000_000n, tick)).toBe(tick * 88n);
    expect(maxQ96FromUsdc(0n, tick)).toBe(0n);
  });
});

describe("ended-now preview", () => {
  const S = 10n ** 18n;
  const clearingQ96 = usdcPerShardToQ96(1_712_000_000n);
  it("spends the whole budget at clearing while the max is above it", () => {
    const p = endedNowPreview({ budgetUsdc: 2_000_000_000n, maxQ96: usdcPerShardToQ96(1_760_000_000n), clearingQ96, forSale: 3 });
    expect(p.clearingUsdc).toBe(1_712_000_000n);
    expect(p.shards).toBe(estimateShards(2_000_000_000n, 1_712_000_000n));
    expect(p.refundedUsdc).toBe(0n);
    expect(p.outAtUsdc).toBe(1_760_000_000n);
  });
  it("caps at the shards for sale and refunds the rest", () => {
    const p = endedNowPreview({ budgetUsdc: 10_000_000_000n, maxQ96: usdcPerShardToQ96(1_760_000_000n), clearingQ96, forSale: 3 });
    expect(p.shards).toBe(3n * S);
    expect(p.refundedUsdc).toBe(10_000_000_000n - 3n * 1_712_000_000n);
  });
  it("gets nothing at or below clearing", () => {
    const p = endedNowPreview({ budgetUsdc: 500_000_000n, maxQ96: clearingQ96, clearingQ96, forSale: 3 });
    expect(p.shards).toBe(0n);
    expect(p.refundedUsdc).toBe(500_000_000n);
  });
});

describe("exit route", () => {
  const cp = (blockNumber: bigint, price: bigint) => ({ blockNumber, clearingPriceQ96: price });
  const checkpoints = [cp(100n, 10n), cp(110n, 20n), cp(120n, 30n), cp(130n, 40n), cp(140n, 50n)];
  const bid = { bidId: 7n, maxPriceQ96: 30n, submittedBlock: 105n };

  it("fully refunds through exitBid when the auction did not graduate", () => {
    expect(exitRoute(bid, false, checkpoints, 50n)).toEqual({ fn: "exitBid", args: [7n] });
  });
  it("uses exitBid for a max above the final clearing", () => {
    expect(exitRoute({ ...bid, maxPriceQ96: 60n }, true, checkpoints, 50n)).toEqual({ fn: "exitBid", args: [7n] });
  });
  it("passes both hints for an outbid bid", () => {
    // Last fully filled: block 110 (20 < 30, at or after submission); outbid: first > 30 is block 130.
    expect(exitRoute(bid, true, [...checkpoints].reverse(), 50n)).toEqual({ fn: "exitPartiallyFilledBid", args: [7n, 110n, 130n] });
  });
  it("passes outbidBlock 0 for a bid exactly at the final clearing", () => {
    const at = [cp(100n, 10n), cp(110n, 20n), cp(120n, 30n)];
    expect(exitRoute(bid, true, at, 30n)).toEqual({ fn: "exitPartiallyFilledBid", args: [7n, 110n, 0n] });
  });
  it("ignores checkpoints before the bid was submitted", () => {
    expect(exitRoute({ ...bid, submittedBlock: 115n }, true, checkpoints, 50n)).toBeNull();
  });
});

describe("bid rows", () => {
  const p = { ended: true, graduated: true, clearingQ96: 30n };
  it("treats a zero-fill exited bid as final", () => {
    expect(bidView({ status: "exited", maxPriceQ96: 20n, tokensFilled: 0n }, p)).toEqual({ label: "refunded", tone: "muted", action: "none" });
  });
  it("offers exit then claim to a filled open bid, claim to an exited one", () => {
    expect(bidView({ status: "open", maxPriceQ96: 40n, tokensFilled: null }, p).action).toBe("exit-claim");
    expect(bidView({ status: "open", maxPriceQ96: 30n, tokensFilled: null }, p).label).toBe("partially filled");
    expect(bidView({ status: "exited", maxPriceQ96: 40n, tokensFilled: 5n }, p).action).toBe("claim");
    expect(bidView({ status: "open", maxPriceQ96: 20n, tokensFilled: null }, p).action).toBe("exit");
  });
  it("labels a live bid exactly at clearing as filling, not outbid", () => {
    const live = { ended: false, graduated: null, clearingQ96: 30n };
    expect(bidView({ status: "open", maxPriceQ96: 30n, tokensFilled: null }, live).label).toBe("at clearing · filling");
    expect(bidView({ status: "open", maxPriceQ96: 20n, tokensFilled: null }, live).label).toBe("outbid");
    expect(bidView({ status: "open", maxPriceQ96: 40n, tokensFilled: null }, live).label).toBe("open");
  });
  it("offers a take-back when the reserve was not met", () => {
    expect(bidView({ status: "open", maxPriceQ96: 40n, tokensFilled: null }, { ...p, graduated: false })).toEqual({ label: "refund due", tone: "kin", action: "take-back" });
  });
});

describe("stats and copy", () => {
  it("computes demand over supply", () => {
    expect(demandRatio(6_678_000_000n, 1_712_000_000n, 3)).toBeCloseTo(1.3, 2);
    expect(demandRatio(1n, 0n, 3)).toBeNull();
  });
  it("describes hook and price reverts", () => {
    expect(bidRevertMessage("Expired")?.title).toBe("Your World ID ticket expired");
    expect(bidRevertMessage("BidMustBeAboveClearingPrice")?.title).toBe("The price moved. Raise your max.");
    expect(isRetryableBidError("AlreadyBound")).toBe(false);
    expect(isRetryableBidError("Expired")).toBe(true);
  });
});
