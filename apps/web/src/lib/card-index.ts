import "server-only";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCb } from "node:zlib";
import { get as blobGet } from "@vercel/blob";
import { manifestMatchesSpec, type CardIndexManifest, type CardIndexRow } from "@/lib/card-index-format";
import { decodeVectors, type VectorIndex } from "@/lib/card-vectors";
import { CARD_EMBED_SPEC } from "@/lib/embed-spec";

export class IndexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexUnavailableError";
  }
}

/** Where the index was loaded from: a directory, or a base URL. */
export type LoadedCardIndex = { source: string; manifest: CardIndexManifest; meta: CardIndexRow[]; vectors: VectorIndex };

/** CARD_INDEX_DIR, or data/card-index under the app (the builder's default output). */
export function cardIndexDir(): string {
  // Runtime data built separately (not traced into the server output).
  return resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.CARD_INDEX_DIR || "data/card-index");
}

/** CARD_INDEX_URL without a trailing slash, or null when unset (then the index is read from cardIndexDir()). */
export function cardIndexUrl(): string | null {
  const url = process.env.CARD_INDEX_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

type RawIndex = { manifest: CardIndexManifest; meta: CardIndexRow[]; bin: Uint8Array };

/** The checks shared by both sources: recipe, then consistency between the three files. */
function check(source: string, { manifest, meta, bin }: RawIndex): LoadedCardIndex {
  // The shipped index is built from Scryfall's `normal` images (the build script's default, and what
  // scripts/eval-embeddings.mts measured best); a `small` build is a different recipe even though the
  // preprocessing spec is identical.
  if (!manifestMatchesSpec(manifest, { ...CARD_EMBED_SPEC, image: "normal" })) {
    throw new IndexUnavailableError(`card index in ${source} was built with ${manifest.model} (${manifest.image} images) and a different recipe than the station uses (${CARD_EMBED_SPEC.model}, normal images); rebuild it`);
  }
  const vectors = decodeVectors(bin, manifest.dims);
  if (vectors.count !== meta.length || vectors.count !== manifest.count) {
    throw new IndexUnavailableError(`card index in ${source} is inconsistent: ${vectors.count} vectors, ${meta.length} meta rows, manifest says ${manifest.count}`);
  }
  return { source, manifest, meta, vectors };
}

const gunzip = promisify(gunzipCb);

/** Parse meta.json bytes, gunzipping them first when they are gzip (meta.json.gz; a host may already have decoded it). */
async function parseMeta(bytes: Uint8Array): Promise<CardIndexRow[]> {
  const gz = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const plain = gz ? await gunzip(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(plain)) as CardIndexRow[];
}

const detail = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function loadDir(dir: string): Promise<LoadedCardIndex> {
  let raw: RawIndex;
  try {
    const [manifest, meta, bin] = await Promise.all([
      readFile(join(dir, "manifest.json"), "utf8").then((s) => JSON.parse(s) as CardIndexManifest),
      // meta.json, or meta.json.gz when only the compressed copy is there.
      readFile(join(dir, "meta.json"))
        .catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? readFile(join(dir, "meta.json.gz")) : Promise.reject(e)))
        .then(parseMeta),
      readFile(join(dir, "vectors.bin")),
    ]);
    raw = { manifest, meta, bin: new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength) };
  } catch (e) {
    throw new IndexUnavailableError(`card index not found or unreadable in ${dir} (build it with pnpm --filter web build:index): ${detail(e)}`);
  }
  return check(dir, raw);
}

/** How long the whole download (all three files) may take before the load fails. */
const URL_TIMEOUT_MS = 20_000;

/**
 * True when the index lives in a private Vercel Blob store: CARD_INDEX_BLOB_ACCESS=private, or a
 * `<store>.private.blob.vercel-storage.com` URL (the host @vercel/blob gives private blobs).
 */
function isPrivateBlob(base: string): boolean {
  if (process.env.CARD_INDEX_BLOB_ACCESS === "private") return true;
  try {
    return new URL(base).hostname.endsWith(".private.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

/** One file's bytes, or null when it does not exist. */
type Fetcher = (url: string, signal: AbortSignal) => Promise<Uint8Array | null>;

const fetchPublic: Fetcher = async (url, signal) => {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

/** Private blobs need the store's token (Vercel injects BLOB_READ_WRITE_TOKEN when the store is connected to the project). */
const fetchPrivate = (token: string): Fetcher => async (url, signal) => {
  const blob = await blobGet(url, { access: "private", token, abortSignal: signal });
  if (!blob) return null;
  if (blob.statusCode !== 200) throw new Error(`HTTP ${blob.statusCode}`);
  return new Uint8Array(await new Response(blob.stream).arrayBuffer());
};

/**
 * Fetch manifest.json, meta.json.gz (or meta.json when there is no .gz) and vectors.bin from `base`
 * and check them like the disk loader does. A private Vercel Blob store is read through
 * @vercel/blob's `get`; anything else with plain fetch.
 */
export async function loadCardIndexFromUrl(base: string, timeoutMs = URL_TIMEOUT_MS): Promise<LoadedCardIndex> {
  let fetcher = fetchPublic;
  if (isPrivateBlob(base)) {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      throw new IndexUnavailableError(`card index at ${base} is in a private Vercel Blob store, but BLOB_READ_WRITE_TOKEN is not set (connect the store to the Vercel project, or set the token)`);
    }
    fetcher = fetchPrivate(token);
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const get = async (name: string, fallback?: string): Promise<Uint8Array> => {
    const bytes = await fetcher(`${base}/${name}`, signal).catch((e) => Promise.reject(new Error(`${name}: ${detail(e)}`)));
    if (bytes) return bytes;
    if (fallback) return get(fallback);
    throw new Error(`${name}: not found`);
  };
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  let raw: RawIndex;
  try {
    const [manifest, meta, bin] = await Promise.all([
      get("manifest.json").then((b) => JSON.parse(text(b)) as CardIndexManifest),
      get("meta.json.gz", "meta.json").then(parseMeta),
      get("vectors.bin"),
    ]);
    raw = { manifest, meta, bin };
  } catch (e) {
    const why = signal.aborted ? `timed out after ${timeoutMs} ms` : detail(e);
    throw new IndexUnavailableError(`card index could not be downloaded from ${base} (upload it with pnpm --filter web upload:index): ${why}`);
  }
  return check(base, raw);
}

const loaded = new Map<string, Promise<LoadedCardIndex>>();

/**
 * Load the index once per source and keep it in memory for the life of the process (a warm
 * serverless instance). The source is CARD_INDEX_URL when set, else CARD_INDEX_DIR. Concurrent first
 * callers share one load; a failed load is not cached, so a later request retries (and a later build
 * or upload is picked up).
 */
export function getCardIndex(): Promise<LoadedCardIndex> {
  const url = cardIndexUrl();
  const source = url ?? cardIndexDir();
  let p = loaded.get(source);
  if (!p) {
    p = url ? loadCardIndexFromUrl(url) : loadDir(source);
    loaded.set(source, p);
    p.catch(() => loaded.delete(source));
  }
  return p;
}
