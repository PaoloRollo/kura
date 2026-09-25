import { CARD_PAGE_FALLBACK } from "@/lib/meta";

/**
 * A cached reader for the vault's on-chain siteURI (card pages are siteURI + id). A failed or empty read falls back to
 * the kuravault.xyz card pages and is retried on the next call.
 */
export function siteUriReader(read: () => Promise<string>, { ttlMs = 10 * 60_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {}) {
  let cached: { value: string; at: number } | null = null;
  return async (): Promise<string> => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    try {
      const value = await read();
      if (!value) return CARD_PAGE_FALLBACK;
      cached = { value, at: now() };
      return value;
    } catch (e) {
      console.error("reading the vault siteURI failed", e instanceof Error ? e.message : e);
      return CARD_PAGE_FALLBACK;
    }
  };
}
