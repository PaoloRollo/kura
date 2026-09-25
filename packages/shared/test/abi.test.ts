import { describe, expect, it } from "vitest";
import { getAbiItem, toFunctionSelector } from "viem";
import { abi } from "../src/abi";

describe("abi", () => {
  it("parses every contract ABI", () => {
    for (const [name, value] of Object.entries(abi)) {
      expect(Array.isArray(value), name).toBe(true);
      expect(value.length, name).toBeGreaterThan(0);
    }
  });
  it("exposes the vault functions the app calls", () => {
    for (const fn of ["mint", "shardAndAuction", "settle", "redeem", "claimPayout", "confirmRelease", "cards", "shardings", "vendor", "feeBps"] as const) {
      expect(getAbiItem({ abi: abi.cardVault, name: fn }), fn).toBeDefined();
    }
    expect(toFunctionSelector(getAbiItem({ abi: abi.permit2, name: "approve" })!)).toBe("0x87517c45");
  });
});
