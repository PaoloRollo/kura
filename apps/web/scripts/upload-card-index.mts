/**
 * Upload the card index to Vercel Blob so a Vercel deployment can load it (CARD_INDEX_URL).
 *
 *   BLOB_READ_WRITE_TOKEN=... pnpm --filter web upload:index            # uploads data/card-index
 *   options: --dir DIR (default data/card-index, or CARD_INDEX_DIR)
 *
 * Uploads manifest.json, meta.json.gz (gzipped here) and vectors.bin under
 * card-index/<builtAt>-<content hash>/ and prints the base URL to set as CARD_INDEX_URL.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { put } from "@vercel/blob";
import { uploadCardIndex } from "./lib/card-index-upload";

const { values } = parseArgs({ options: { dir: { type: "string" } } });
const dir = resolve(values.dir ?? process.env.CARD_INDEX_DIR ?? "data/card-index");

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set (Vercel dashboard > Storage > your Blob store > .env.local)");
  process.exit(1);
}

console.log(`uploading ${dir} ...`);
const { baseUrl } = await uploadCardIndex(dir, put);
console.log(`done. Set this in the Vercel project's environment:\n\nCARD_INDEX_URL=${baseUrl}\n`);
