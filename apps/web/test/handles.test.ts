import { describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, type Address } from "viem";
import { checkHandle, displayName, handleMessage, reasonFromRevert, type HandleReader } from "@/lib/handles";

const ME = "0x00000000000000000000000000000000000000aa" as Address;
const reader = (o: { reservedOnChain?: string[]; taken?: string[]; mine?: string } = {}): HandleReader => ({
  reserved: vi.fn(async (h: `0x${string}`) => (o.reservedOnChain ?? []).some((l) => keccak256(toBytes(l)) === h)),
  isAvailable: vi.fn(async (l: string) => !(o.taken ?? []).includes(l)),
  collectorLabel: vi.fn(async () => o.mine ?? ""),
});

describe("checkHandle", () => {
  it("accepts a free handle, trimmed and lowercased", async () => {
    const r = reader();
    expect(await checkHandle("  Paolo ", r, ME)).toEqual({ available: true });
    expect(r.isAvailable).toHaveBeenCalledWith("paolo");
  });

  it("refuses bad shapes before touching the chain", async () => {
    const r = reader();
    for (const l of ["", "ab", "a".repeat(33), "pa-olo", "pa.olo", "paolo!"]) {
      expect(await checkHandle(l, r)).toEqual({ available: false, reason: "INVALID" });
    }
    expect(r.isAvailable).not.toHaveBeenCalled();
  });

  it("reports the shared reserved list and the on-chain reserved set as RESERVED", async () => {
    expect(await checkHandle("vault", reader())).toEqual({ available: false, reason: "RESERVED" });
    expect(await checkHandle("kurateam", reader({ reservedOnChain: ["kurateam"] }))).toEqual({ available: false, reason: "RESERVED" });
  });

  it("follows the contract's revert order: reserved, then taken, then already named", async () => {
    expect(await checkHandle("kenji", reader({ taken: ["kenji"], mine: "paolo" }), ME)).toEqual({ available: false, reason: "TAKEN" });
    expect(await checkHandle("aiko", reader({ mine: "paolo" }), ME)).toEqual({ available: false, reason: "ALREADY_NAMED", label: "paolo" });
    // Without an address there is no wallet to check.
    expect(await checkHandle("aiko", reader({ mine: "paolo" }))).toEqual({ available: true });
  });
});

describe("handleMessage and reasonFromRevert", () => {
  it("words each outcome the way the field shows it", () => {
    expect(handleMessage({ available: true }, "paolo", "kura.eth")).toBe("Available · 3 to 32 lowercase letters or digits, no dashes");
    expect(handleMessage({ available: false, reason: "TAKEN" }, "kenji", "kura.eth")).toBe("kenji.kura.eth is taken");
    expect(handleMessage({ available: false, reason: "RESERVED" }, "vault", "kura.eth")).toBe("vault is reserved");
    expect(handleMessage({ available: false, reason: "INVALID" }, "a", "kura.eth")).toBe("3 to 32 lowercase letters or digits, no dashes");
    expect(handleMessage({ available: false, reason: "ALREADY_NAMED", label: "paolo" }, "x", "kura.eth")).toMatch(/already has paolo\.kura\.eth/);
    expect(handleMessage({ checking: true }, "x", "kura.eth")).toBe("Checking…");
  });

  it("maps the CardNames reverts to the live check's reasons", () => {
    expect(reasonFromRevert("InvalidHandle")).toBe("INVALID");
    expect(reasonFromRevert("HandleReserved")).toBe("RESERVED");
    expect(reasonFromRevert("HandleTaken")).toBe("TAKEN");
    expect(reasonFromRevert("AlreadyNamed")).toBe("ALREADY_NAMED");
    expect(reasonFromRevert("Expired")).toBeNull();
    expect(reasonFromRevert(null)).toBeNull();
  });
});

describe("displayName", () => {
  const parties = {
    vendor: "0x7aD58bd97A7cd456dC854B1cEc95eC80f6F4F9fe",
    signer: "0x3Ee6A2194D10f199E5271a72Dd3ba8F64DE3b731",
    cardVault: "0xEC598d41513A15Bb17D4FAeF5e127aB47A54f1B4",
    cardNames: "0x93f5A4c05A6Ba8f785463efD3C15B34c72C63c49",
    ensParentLabel: "kura",
  };
  const kenji = "0x4f2ca0b3ae1f3d7a0b6d2f0c1e4b5a6d7c8ea81e";
  const handles = { [kenji]: "kenji", [parties.vendor.toLowerCase()]: "vendor" };

  it("names the parties, the vault contracts and collectors", () => {
    expect(displayName(parties.vendor.toLowerCase(), handles, parties)).toBe("kura.eth");
    expect(displayName(parties.signer, handles, parties)).toBe("appraiser.kura.eth");
    expect(displayName(parties.cardVault, handles, parties)).toBe("vault");
    expect(displayName(parties.cardNames.toLowerCase(), handles, parties)).toBe("vault");
    expect(displayName("0x4F2CA0B3AE1F3D7A0B6D2F0C1E4B5A6D7C8EA81E", handles, parties)).toBe("kenji.kura.eth");
  });

  it("falls back to the short address", () => {
    expect(displayName("0x00000000000000000000000000000000000000aa", handles, parties)).toBe("0x0000…00aa");
  });
});
