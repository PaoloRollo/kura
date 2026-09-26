import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { OWNER_ERRORS, handleForAddress, parseOwnerInput, resolveOwner } from "@/lib/owner";

const KENJI = "0x4f2ca0b3ae1f3d7a0b6d2f0c1e4b5a6d7c8ea81e";
const directory = () => {
  const byLabel = vi.fn(async (label: string) => (label === "kenji" ? KENJI : null));
  const byAddress = vi.fn(async (a: string) => (a.toLowerCase() === KENJI ? "kenji" : null));
  return { byLabel, byAddress };
};

describe("parseOwnerInput", () => {
  it("takes a bare or full Kura handle, case-insensitively", () => {
    expect(parseOwnerInput("kenji")).toEqual({ kind: "handle", label: "kenji" });
    expect(parseOwnerInput("  Kenji.Kura.ETH ")).toEqual({ kind: "handle", label: "kenji" });
    expect(parseOwnerInput("")).toEqual({ kind: "empty" });
  });

  it("rejects card names, other ENS names and raw addresses", () => {
    expect(parseOwnerInput("black-lotus-lea-1")).toEqual({ kind: "error", error: OWNER_ERRORS.cardName });
    expect(parseOwnerInput("black-lotus-lea-1.kura.eth")).toEqual({ kind: "error", error: OWNER_ERRORS.cardName });
    expect(parseOwnerInput("vitalik.eth")).toEqual({ kind: "error", error: OWNER_ERRORS.notHandle });
    expect(parseOwnerInput("a.kenji.kura.eth")).toEqual({ kind: "error", error: OWNER_ERRORS.notHandle });
    expect(parseOwnerInput(KENJI)).toEqual({ kind: "error", error: OWNER_ERRORS.notHandle });
    expect(parseOwnerInput("0x4f2c")).toEqual({ kind: "error", error: OWNER_ERRORS.notHandle });
  });
});

describe("resolveOwner", () => {
  it("resolves a handle through the collectors directory", async () => {
    const d = directory();
    expect(await resolveOwner("kenji.kura.eth", d)).toEqual({ ok: true, address: getAddress(KENJI), name: "kenji.kura.eth" });
    expect(d.byLabel).toHaveBeenCalledWith("kenji");
  });

  it("reports an unknown handle without guessing", async () => {
    expect(await resolveOwner("ren", directory())).toEqual({ ok: false, error: OWNER_ERRORS.unknown });
    // Not a valid handle (too short, reserved): no lookup, no collector.
    const d = directory();
    expect(await resolveOwner("ab", d)).toEqual({ ok: false, error: OWNER_ERRORS.unknown });
    expect(await resolveOwner("vendor", d)).toEqual({ ok: false, error: OWNER_ERRORS.unknown });
    expect(d.byLabel).not.toHaveBeenCalled();
  });

  it("never looks up rejected input", async () => {
    const d = directory();
    expect(await resolveOwner("vitalik.eth", d)).toEqual({ ok: false, error: OWNER_ERRORS.notHandle });
    expect(await resolveOwner("mox-sapphire-lea-2", d)).toEqual({ ok: false, error: OWNER_ERRORS.cardName });
    expect(d.byLabel).not.toHaveBeenCalled();
  });

  it("turns a lookup failure into an error", async () => {
    const out = await resolveOwner("kenji", { byLabel: async () => { throw new Error("down"); }, byAddress: async () => null });
    expect(out).toEqual({ ok: false, error: OWNER_ERRORS.unavailable });
  });
});

describe("handleForAddress", () => {
  it("names a scanned address by its Kura handle, or null", async () => {
    expect(await handleForAddress(KENJI, directory())).toBe("kenji.kura.eth");
    expect(await handleForAddress("0x0000000000000000000000000000000000000001", directory())).toBeNull();
    expect(await handleForAddress(KENJI, { byLabel: async () => null, byAddress: async () => { throw new Error("down"); } })).toBeNull();
  });
});
