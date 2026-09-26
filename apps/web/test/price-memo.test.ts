import { beforeEach, describe, expect, it } from "vitest";
import { MEMO_MAX, MEMO_TTL_MS, memoGet, memoSet, memoSize, resetPriceMemo } from "@/lib/price-memo";

describe("price memo", () => {
  beforeEach(() => resetPriceMemo());

  it("keeps a value, null included, for 45 s", () => {
    expect(MEMO_TTL_MS).toBe(45_000);
    memoSet("1", null, 0);
    expect(memoGet("1", 44_999)).toEqual({ value: null });
    expect(memoGet("1", 45_001)).toBeUndefined();
    expect(memoGet("2", 0)).toBeUndefined();
  });

  it("evicts once it passes 2000 entries", () => {
    expect(MEMO_MAX).toBe(2000);
    for (let i = 0; i < 2500; i++) memoSet(String(i), null, i);
    expect(memoSize()).toBeLessThanOrEqual(2000);
    expect(memoGet("2499", 2500)).toBeDefined();
    expect(memoGet("0", 2500)).toBeUndefined();
  });
});
