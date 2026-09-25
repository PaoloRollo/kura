import { describe, expect, it } from "vitest";
import { cardLabel, isCondition, isLanguage, isValidHandle, setCode, slugify } from "../src/labels";

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify("Black Lotus")).toBe("black-lotus");
  });
  it("collapses punctuation and never leaves edge or double dashes", () => {
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

describe("slugify length", () => {
  const LABEL_PART = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

  it("slugs only the front face of a multi-face card", () => {
    expect(slugify("Fire // Ice")).toBe("fire");
    expect(slugify("Tamiyo, Inquisitive Student // Tamiyo, Seasoned Scholar")).toBe("tamiyo-inquisitive-student");
    expect(slugify("Liliana, Heretical Healer // Liliana, Defiant Necromancer")).toBe("liliana-heretical-healer");
    expect(slugify("Ojer Taq, Deepest Foundation // Temple of Civilization")).toBe("ojer-taq-deepest-foundation");
  });

  it("caps a long single face at 48 characters on a dash boundary", () => {
    const name = "Our Market Research Shows That Players Like Really Long Card Names So We Made this Card to Have the Absolute Longest Card Name Ever Elemental";
    const slug = slugify(name);
    expect(slug).toBe("our-market-research-shows-that-players-like");
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug).toMatch(LABEL_PART);
  });

  it("keeps a word that ends exactly at 48 characters", () => {
    const name = `${"a".repeat(40)} ${"b".repeat(7)} tail`;
    expect(slugify(name)).toBe(`${"a".repeat(40)}-${"b".repeat(7)}`);
  });

  it("hard-cuts one very long word", () => {
    expect(slugify("x".repeat(60))).toBe("x".repeat(48));
  });

  it("never returns an empty string", () => {
    for (const name of ["日本語", "", "!!!", " // Back"]) {
      const slug = slugify(name);
      expect(slug.length).toBeGreaterThan(0);
      expect(slug).toMatch(LABEL_PART);
    }
  });
});

describe("setCode and labels", () => {
  it("normalises set codes", () => {
    expect(setCode("LEA")).toBe("lea");
    expect(setCode("2XM")).toBe("2xm");
    expect(() => setCode("le-a")).toThrow();
    expect(() => setCode("")).toThrow();
  });
  it("accepts set codes up to the contract's 48-byte label limit", () => {
    expect(setCode("PLST2024ABCDEFGH")).toBe("plst2024abcdefgh");
    expect(setCode("A".repeat(48))).toBe("a".repeat(48));
    expect(() => setCode("a".repeat(49))).toThrow();
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
