import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { CardIndexManifest } from "../../src/lib/card-index-format";

export type BlobAccess = "private" | "public";

/** CARD_INDEX_BLOB_ACCESS: which kind of Blob store the index goes to. Private unless told otherwise. */
export function blobAccessFromEnv(value: string | undefined): BlobAccess {
  if (!value) return "private";
  if (value === "private" || value === "public") return value;
  throw new Error(`CARD_INDEX_BLOB_ACCESS must be "private" or "public", got ${JSON.stringify(value)}`);
}

/** The env lines to set on the Vercel project for an index uploaded to `baseUrl`. */
export function envLines(baseUrl: string, access: BlobAccess): string[] {
  return [`CARD_INDEX_URL=${baseUrl}`, ...(access === "private" ? ["CARD_INDEX_BLOB_ACCESS=private"] : [])];
}

type PutOptions = { access: BlobAccess; addRandomSuffix: false; allowOverwrite: boolean; contentType: string; cacheControlMaxAge: number };
/** The slice of `@vercel/blob`'s `put` this uses (injectable for tests). */
export type BlobPut = (pathname: string, body: Buffer, options: PutOptions) => Promise<{ url: string }>;

/** Blobs live under a prefix unique to their content, so they never change: let caches keep them. */
const ONE_YEAR = 365 * 24 * 60 * 60;

/**
 * Upload the index in `dir` (manifest.json, meta.json, vectors.bin) to a private (default) or public Vercel Blob store under
 * card-index/<builtAt>-<content hash>/, with meta.json gzipped to meta.json.gz. Returns the base URL
 * to set as CARD_INDEX_URL. The manifest goes last, so a prefix whose upload failed halfway has no
 * manifest and never loads.
 */
export async function uploadCardIndex(dir: string, put: BlobPut, access: BlobAccess = "private"): Promise<{ prefix: string; baseUrl: string }> {
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name));
    } catch (e) {
      throw new Error(`no ${name} in ${dir} (build the index with pnpm --filter web build:index): ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const manifestBytes = read("manifest.json");
  const meta = read("meta.json");
  const vectors = read("vectors.bin");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as CardIndexManifest;

  const hash = createHash("sha256").update(manifestBytes).update(meta).update(vectors).digest("hex").slice(0, 8);
  const stamp = manifest.builtAt.replace(/[-:]|\.\d+/g, ""); // 2026-09-25T15:09:08.758Z -> 20260925T150908Z
  const prefix = `card-index/${stamp}-${hash}`;

  const options = (contentType: string): PutOptions => ({ access, addRandomSuffix: false, allowOverwrite: true, contentType, cacheControlMaxAge: ONE_YEAR });
  await Promise.all([
    put(`${prefix}/meta.json.gz`, gzipSync(meta, { level: 9 }), options("application/gzip")),
    put(`${prefix}/vectors.bin`, vectors, options("application/octet-stream")),
  ]);
  const { url } = await put(`${prefix}/manifest.json`, manifestBytes, options("application/json"));
  return { prefix, baseUrl: url.replace(/\/manifest\.json$/, "") };
}
