import { describe, expect, it } from "vitest";
import { sameEnsToken } from "../src/lib/ens";

describe("sameEnsToken", () => {
  const base = 0xabcdefn << 32n;
  it("ignores the version in the low 32 bits", () => {
    expect(sameEnsToken(base, base + 1n)).toBe(true);
    expect(sameEnsToken(base | 0xffffffffn, base)).toBe(true);
  });
  it("distinguishes different names", () => {
    expect(sameEnsToken(base, base + (1n << 32n))).toBe(false);
  });
});
