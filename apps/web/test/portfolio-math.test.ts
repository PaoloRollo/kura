import { describe, expect, it } from "vitest";
import { costBasis, referencePrice, unrealized } from "@/lib/portfolio-math";

describe("portfolio math", () => {
  it("averages cost over filled shards", () => {
    const bids = [
      { status: "claimed" as const, amountUsdc: 10_000_000n, currencyRefunded: 0n, tokensFilled: 10n ** 18n },
      { status: "exited" as const, amountUsdc: 15_000_000n, currencyRefunded: 3_000_000n, tokensFilled: 12n * 10n ** 17n },
      { status: "open" as const, amountUsdc: 99n, currencyRefunded: null, tokensFilled: null },
      { status: "exited" as const, amountUsdc: 5_000_000n, currencyRefunded: 5_000_000n, tokensFilled: 0n },
    ];
    expect(costBasis(bids)).toBe(10_000_000n);
    expect(costBasis([bids[2]!])).toBeNull();
    expect(costBasis([bids[3]!])).toBeNull();
  });
  it("computes unrealized gain and picks the reference price", () => {
    expect(unrealized(12_000_000n, 10_000_000n, 2n * 10n ** 18n)).toBe(4_000_000n);
    expect(unrealized(9_000_000n, 10_000_000n, 10n ** 18n)).toBe(-1_000_000n);
    expect(referencePrice({ settled: true, graduated: true, redeemer: "0x1", buyoutPerShard: 12n, clearingUsdcPerShard: 10n })).toBe(12n);
    expect(referencePrice({ settled: true, graduated: true, redeemer: null, buyoutPerShard: null, clearingUsdcPerShard: 10n })).toBe(10n);
    expect(referencePrice({ settled: false, graduated: null, redeemer: null, buyoutPerShard: null, clearingUsdcPerShard: 9n })).toBe(9n);
    expect(referencePrice({ settled: true, graduated: false, redeemer: null, buyoutPerShard: null, clearingUsdcPerShard: null })).toBeNull();
    expect(referencePrice({ settled: false, graduated: null, redeemer: null, buyoutPerShard: null, clearingUsdcPerShard: null })).toBeNull();
  });
});
