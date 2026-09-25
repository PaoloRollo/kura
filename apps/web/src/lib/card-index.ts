import "server-only";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { manifestMatchesSpec, type CardIndexManifest, type CardIndexRow } from "@/lib/card-index-format";
import { decodeVectors, type VectorIndex } from "@/lib/card-vectors";
import { CARD_EMBED_SPEC } from "@/lib/embed-spec";

export class IndexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexUnavailableError";
  }
}

export type LoadedCardIndex = { dir: string; manifest: CardIndexManifest; meta: CardIndexRow[]; vectors: VectorIndex };

/** CARD_INDEX_DIR, or data/card-index under the app (the builder's default output). */
export function cardIndexDir(): string {
  // Runtime data built separately (not traced into the server output).
  return resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.CARD_INDEX_DIR || "data/card-index");
}

async function load(dir: string): Promise<LoadedCardIndex> {
  let manifest: CardIndexManifest, meta: CardIndexRow[], bin: Buffer;
  try {
    [manifest, meta, bin] = await Promise.all([
      readFile(join(dir, "manifest.json"), "utf8").then((s) => JSON.parse(s) as CardIndexManifest),
      readFile(join(dir, "meta.json"), "utf8").then((s) => JSON.parse(s) as CardIndexRow[]),
      readFile(join(dir, "vectors.bin")),
    ]);
  } catch (e) {
    throw new IndexUnavailableError(`card index not found or unreadable in ${dir} (build it with pnpm --filter web build:index): ${e instanceof Error ? e.message : String(e)}`);
  }
  // The shipped index is built from Scryfall's `normal` images (the build script's default, and what
  // scripts/eval-embeddings.mts measured best); a `small` build is a different recipe even though the
  // preprocessing spec is identical.
  if (!manifestMatchesSpec(manifest, { ...CARD_EMBED_SPEC, image: "normal" })) {
    throw new IndexUnavailableError(`card index in ${dir} was built with ${manifest.model} (${manifest.image} images) and a different recipe than the station uses (${CARD_EMBED_SPEC.model}, normal images); rebuild it`);
  }
  const vectors = decodeVectors(new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength), manifest.dims);
  if (vectors.count !== meta.length || vectors.count !== manifest.count) {
    throw new IndexUnavailableError(`card index in ${dir} is inconsistent: ${vectors.count} vectors, ${meta.length} meta rows, manifest says ${manifest.count}`);
  }
  return { dir, manifest, meta, vectors };
}

const loaded = new Map<string, Promise<LoadedCardIndex>>();

/** Load the index once per directory and keep it in memory. A failed load is not cached, so a later build is picked up. */
export function getCardIndex(dir = cardIndexDir()): Promise<LoadedCardIndex> {
  let p = loaded.get(dir);
  if (!p) {
    p = load(dir);
    loaded.set(dir, p);
    p.catch(() => loaded.delete(dir));
  }
  return p;
}
