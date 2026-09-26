import { describe, expect, it } from "vitest";
import { acceptCollectorRecord, addressRecordOf, ensTokenPrefix, isUnlink, labelHashOf, nameKindOf, sameEnsToken } from "../src/lib/ens";

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

// Live Sepolia: black-lotus-lea-1 registered with tokenId 0xfbeb…db3100000000 and labelHash 0xfbeb…db31643f2365.
const liveLabelHash = "0xfbebcbfa6be5c9879e5c28ecc314958deed1f8a37c73e45611d7db31643f2365";
const liveTokenId = 0xfbebcbfa6be5c9879e5c28ecc314958deed1f8a37c73e45611d7db3100000000n;

describe("labelHashOf", () => {
  it("is keccak256 of the label bytes, matching the live registry", () => {
    expect(labelHashOf("black-lotus-lea-1")).toBe(liveLabelHash);
  });
});

describe("ensTokenPrefix", () => {
  it("is the same for the versioned tokenId and the raw labelhash", () => {
    expect(ensTokenPrefix(liveTokenId)).toBe(ensTokenPrefix(BigInt(liveLabelHash)));
    expect(liveLabelHash.startsWith(ensTokenPrefix(liveTokenId))).toBe(true);
    expect(sameEnsToken(liveTokenId, BigInt(liveLabelHash))).toBe(true);
  });
  it("is 0x plus 56 lowercase hex chars, left-padded", () => {
    expect(ensTokenPrefix(1n << 32n)).toBe(`0x${"0".repeat(55)}1`);
  });
});

describe("nameKindOf", () => {
  it("classifies registry labels", () => {
    expect(nameKindOf("appraiser")).toBe("agent");
    expect(nameKindOf("black-lotus-lea-1")).toBe("card");
    expect(nameKindOf("paolo")).toBe("collector");
  });
});

describe("acceptCollectorRecord", () => {
  const resolver = "0x1111111111111111111111111111111111111111";
  const own = "0x0589af38c4cac3fc62158359a92d9722514d83c7e1afe9aeb0a84b9df1fa59a8";
  const card = "0xfbebcbfa6be5c9879e5c28ecc314958deed1f8a37c73e45611d7db31643f2365";
  const collector = { resolver, node: own } as const;
  it("accepts a record for the collector's own node, ignoring address case", () => {
    expect(acceptCollectorRecord(collector, "0x1111111111111111111111111111111111111111", own)).toBe(true);
    expect(acceptCollectorRecord({ resolver: "0xABCDEF0000000000000000000000000000000000", node: own }, "0xabcdef0000000000000000000000000000000000", own.toUpperCase().replace("0X", "0x") as `0x${string}`)).toBe(true);
  });
  it("rejects a spoofed record for another node on the collector's resolver", () => {
    expect(acceptCollectorRecord(collector, resolver, card)).toBe(false);
  });
  it("rejects an unknown resolver", () => {
    expect(acceptCollectorRecord(undefined, resolver, own)).toBe(false);
    expect(acceptCollectorRecord(collector, "0x2222222222222222222222222222222222222222", own)).toBe(false);
  });
});

describe("addressRecordOf", () => {
  const holder = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
  it("stores the ETH address (coin type 60) under addr, lowercase", () => {
    expect(addressRecordOf(60n, holder)).toEqual({ key: "addr", value: holder.toLowerCase() });
  });
  it("reads a cleared ETH address as the zero address, as addr() returns", () => {
    expect(addressRecordOf(60n, "0x")).toEqual({ key: "addr", value: "0x0000000000000000000000000000000000000000" });
  });
  it("keeps other coin types under addr:<coinType>", () => {
    expect(addressRecordOf(0x80000000n, holder)).toEqual({ key: "addr:2147483648", value: holder.toLowerCase() });
    expect(addressRecordOf(0x80000000n, "0x")).toEqual({ key: "addr:2147483648", value: "0x0000000000000000000000000000000000000000" });
    expect(addressRecordOf(0n, "0x00AB")).toEqual({ key: "addr:0", value: "0x00ab" });
    expect(addressRecordOf(0n, "0x")).toEqual({ key: "addr:0", value: "0x" });
  });
});

describe("isUnlink", () => {
  it("is a Linked event to record 0 (linkToRecord(name, 0))", () => {
    expect(isUnlink(0n)).toBe(true);
    expect(isUnlink(1n)).toBe(false);
  });
});
