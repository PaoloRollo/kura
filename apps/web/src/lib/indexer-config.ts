// The indexer's URL. In development it defaults to a local Ponder; a production build without one would otherwise
// query localhost and spin forever, so there it is a visible configuration error instead.

const LOCAL = "http://localhost:42069";

/** The browser's indexer configuration problem, or null. NEXT_PUBLIC_* is inlined at build, so it is read literally. */
export function indexerConfigError(env: { nodeEnv: string | undefined; url: string | undefined } = { nodeEnv: process.env.NODE_ENV, url: process.env.NEXT_PUBLIC_PONDER_URL }): string | null {
  if (env.nodeEnv !== "production" || env.url) return null;
  return "Indexer not configured: NEXT_PUBLIC_PONDER_URL is not set for this deployment, so vault data can't load.";
}

/** The browser's indexer URL (local Ponder in development). */
export const browserIndexerUrl = () => process.env.NEXT_PUBLIC_PONDER_URL || LOCAL;

/** The server's indexer URL; throws in production without PONDER_URL (routes turn that into a 503). */
export function serverIndexerUrl(env: { nodeEnv: string | undefined; url: string | undefined } = { nodeEnv: process.env.NODE_ENV, url: process.env.PONDER_URL }): string {
  if (env.url) return env.url;
  if (env.nodeEnv === "production") throw new Error("Indexer not configured: PONDER_URL is not set");
  return LOCAL;
}
