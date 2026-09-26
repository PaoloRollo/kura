import { describe, expect, it } from "vitest";
import { moneyExact } from "@/lib/format";

describe("moneyExact", () => {
  it("shows every USDC decimal a price has, at least two, trailing zeros dropped", () => {
    expect(moneyExact(1_370n)).toBe("$0.00137");
    expect(moneyExact(135_630n)).toBe("$0.13563");
    expect(moneyExact(137_000n)).toBe("$0.137");
    expect(moneyExact(20_000n)).toBe("$0.02");
    expect(moneyExact(1_712_000_000n)).toBe("$1,712.00");
    expect(moneyExact(0n)).toBe("$0.00");
  });
});
