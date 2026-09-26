import { describe, expect, it } from "vitest";
import { money, moneySig } from "@/lib/format";

describe("moneySig", () => {
  it("formats a cent or more exactly like money: two decimals, grouped", () => {
    expect(moneySig(20_000n)).toBe("$0.02");
    expect(moneySig(1_712_000_000n)).toBe("$1,712.00");
    expect(moneySig(10_000n)).toBe(money(10_000n));
  });

  it("keeps a sub-cent amount readable, stopping at its first non-zero decimal (truncated, like money)", () => {
    expect(moneySig(1_600n)).toBe("$0.001"); // $0.0016
    expect(moneySig(200n)).toBe("$0.0002");
    expect(moneySig(99n)).toBe("$0.00009");
    expect(moneySig(5n)).toBe("$0.000005");
    expect(moneySig(9_999n)).toBe("$0.009");
  });

  it("never reads as $0.00 unless it is zero", () => {
    for (const x of [1n, 7n, 45n, 310n, 4_200n]) expect(moneySig(x)).not.toMatch(/^\$0\.0+$/);
    expect(moneySig(0n)).toBe("$0.00");
    expect(moneySig(-1_600n)).toBe("-$0.001");
  });
});
