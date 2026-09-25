import { describe, expect, it } from "vitest";
import { q96ToUsdcPerShard, usdcPerShardToQ96 } from "../src/lib/math";

describe("math", () => {
  it("round-trips USDC per shard through Q96 like the contracts", () => {
    for (const usdc of [1n, 500_000n, 10_000_000n, 25_000_000_000n]) {
      expect(q96ToUsdcPerShard(usdcPerShardToQ96(usdc))).toBe(usdc);
    }
  });
  it("floors when converting back", () => {
    const q = usdcPerShardToQ96(10_000_000n) - 1n;
    expect(q96ToUsdcPerShard(q)).toBe(9_999_999n);
  });
});
