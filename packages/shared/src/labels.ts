export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const RESERVED_HANDLES = ["appraiser", "vault", "vendor", "admin", "www", "app", "api", "ens", "eth"] as const;

/** Longest label part `CardVault._requireLabelPart` accepts, in bytes (slugs and set codes are ascii). */
export const MAX_LABEL_PART = 48;

function asciiSlug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[æÆ]/g, "ae")
    .replace(/[øØ]/g, "o")
    .replace(/[ßẞ]/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Scryfall English card name -> on-chain slug: ascii, lowercase, [a-z0-9] runs joined by single dashes.
 * Multi-face cards ("Front // Back") slug the front face only. The result is capped at MAX_LABEL_PART,
 * cut back to the last whole word when possible, never ends in a dash, and is never empty.
 */
export function slugify(name: string): string {
  const slug = asciiSlug(name.split(" // ")[0]) || asciiSlug(name) || "card";
  if (slug.length <= MAX_LABEL_PART) return slug;
  const cut = slug.slice(0, MAX_LABEL_PART);
  if (slug[MAX_LABEL_PART] === "-") return cut;
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

export function setCode(code: string): string {
  const s = code.toLowerCase();
  if (!new RegExp(`^[a-z0-9]{1,${MAX_LABEL_PART}}$`).test(s)) throw new Error(`invalid set code: ${code}`);
  return s;
}

export function cardLabel(slug: string, set: string, tokenId: bigint | number): string {
  return `${slug}-${set}-${tokenId.toString()}`;
}

export function isValidHandle(label: string): boolean {
  if (!/^[a-z0-9]{3,32}$/.test(label)) return false;
  return !(RESERVED_HANDLES as readonly string[]).includes(label);
}

export function isCondition(s: string): s is Condition {
  return (CONDITIONS as readonly string[]).includes(s);
}

export function isLanguage(s: string): boolean {
  return /^[a-z]{2,3}$/.test(s);
}
