import { describe, expect, it } from "vitest";
import { cardLabel, isCondition, isLanguage, isValidHandle, setCode, slugify } from "../src/labels";

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify("Black Lotus")).toBe("black-lotus");
  });
  it("collapses punctuation and never leaves edge or double dashes", () => {
    expect(slugify("Fire // Ice")).toBe("fire-ice");
    expect(slugify("Ach! Hans, Run!")).toBe("ach-hans-run");
    expect(slugify("  --Mox--Pearl--  ")).toBe("mox-pearl");
  });
  it("strips diacritics to ascii", () => {
    expect(slugify("Jötun Grunt")).toBe("jotun-grunt");
    expect(slugify("Lim-Dûl's Vault")).toBe("lim-dul-s-vault");
  });
  it("only ever emits [a-z0-9-]", () => {
    for (const name of ["Æther Vial", "Sol Ring", "Urza's Saga", "10 // 20", "日本語"]) {
      expect(slugify(name)).toMatch(/^[a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });
});

describe("setCode and labels", () => {
  it("normalises set codes", () => {
    expect(setCode("LEA")).toBe("lea");
    expect(setCode("2XM")).toBe("2xm");
    expect(() => setCode("le-a")).toThrow();
  });
  it("builds the card label", () => {
    expect(cardLabel("black-lotus", "lea", 1n)).toBe("black-lotus-lea-1");
    expect(cardLabel("black-lotus", "lea", 42)).toBe("black-lotus-lea-42");
  });
});

describe("handles", () => {
  it("accepts a-z0-9 of length 3..32 without dashes", () => {
    expect(isValidHandle("alice")).toBe(true);
    expect(isValidHandle("a1b2c3")).toBe(true);
    expect(isValidHandle("al")).toBe(false);
    expect(isValidHandle("Alice")).toBe(false);
    expect(isValidHandle("al-ice")).toBe(false);
    expect(isValidHandle("a".repeat(33))).toBe(false);
  });
  it("rejects reserved handles", () => {
    for (const r of ["appraiser", "vault", "vendor", "admin", "www", "app", "api", "ens", "eth"]) {
      expect(isValidHandle(r)).toBe(false);
    }
  });
});

describe("conditions and languages", () => {
  it("knows the five conditions", () => {
    expect(isCondition("NM")).toBe(true);
    expect(isCondition("DMG")).toBe(true);
    expect(isCondition("MINT")).toBe(false);
  });
  it("accepts 2 to 3 letter lowercase language codes", () => {
    expect(isLanguage("en")).toBe(true);
    expect(isLanguage("zhs")).toBe(true);
    expect(isLanguage("EN")).toBe(false);
    expect(isLanguage("english")).toBe(false);
  });
});
