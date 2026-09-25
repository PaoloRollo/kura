/**
 * Upload the card index to Vercel Blob so a Vercel deployment can load it (CARD_INDEX_URL).
 *
 *   BLOB_READ_WRITE_TOKEN=... pnpm --filter web upload:index            # uploads data/card-index
 *   options: --dir DIR (default data/card-index, or CARD_INDEX_DIR)
 *   CARD_INDEX_BLOB_ACCESS=public for a public store (default private: the store's access must match)
 *
 * Uploads manifest.json, meta.json.gz (gzipped here) and vectors.bin under
 * card-index/<builtAt>-<content hash>/ and prints the env to set: CARD_INDEX_URL (and
 * CARD_INDEX_BLOB_ACCESS=private for a private store).
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { put } from "@vercel/blob";
import { blobAccessFromEnv, envLines, uploadCardIndex } from "./lib/card-index-upload";

const { values } = parseArgs({ options: { dir: { type: "string" } } });
const dir = resolve(values.dir ?? process.env.CARD_INDEX_DIR ?? "data/card-index");

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set (Vercel dashboard > Storage > your Blob store > .env.local)");
  process.exit(1);
}

const access = blobAccessFromEnv(process.env.CARD_INDEX_BLOB_ACCESS);
console.log(`uploading ${dir} to a ${access} Blob store ...`);
const { baseUrl } = await uploadCardIndex(dir, put, access);
console.log(`done. Set this in the Vercel project's environment:\n\n${envLines(baseUrl, access).join("\n")}\n`);
