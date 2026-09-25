export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const RESERVED_HANDLES = ["appraiser", "vault", "vendor", "admin", "www", "app", "api", "ens", "eth"] as const;

/** Scryfall English card name -> on-chain slug: ascii, lowercase, [a-z0-9] runs joined by single dashes. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[æÆ]/g, "ae")
    .replace(/[øØ]/g, "o")
    .replace(/[ßẞ]/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function setCode(code: string): string {
  const s = code.toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(s)) throw new Error(`invalid set code: ${code}`);
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
