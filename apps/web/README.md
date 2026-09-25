# Kura web

Next.js app for Kura: the vendor station at /vendor and the collector app at /app.

    pnpm --filter web dev
    pnpm --filter web test

## Card image index

The scan station matches a webcam photo against a vector index built offline by
`scripts/build-card-index.mts` into `CARD_INDEX_DIR` (default `data/card-index`, see
`src/lib/card-index.ts`). That directory is git-ignored, so it is not part of the deploy
artifact — it must be built or copied onto the server separately before the scan station
will work there (see `# CARD_INDEX_DIR=` in the root `.env.example`). On Vercel, where there is
no disk to copy it to, the server downloads it from `CARD_INDEX_URL` instead (see "Deploying on
Vercel" below). Either way, until the index loads `/api/scan/match` answers 503
`INDEX_UNAVAILABLE` and the station falls back to search by name.

The guard that keeps `@huggingface/transformers` (and its Node backend, onnxruntime-node) out
of the server bundle — it should only ship in the browser build, via `src/lib/card-embed.ts`
— is a Turbopack `resolveAlias` in `next.config.ts`, which only Turbopack applies. `next
build --webpack` is therefore unsupported: a webpack build would bundle it into the server
output too instead of stubbing it out there.

## Deploy notes

- **Server env is validated all at once.** `serverEnv()` in `src/env.ts` parses every server
  var in one schema the first time the server needs any of them (the first authenticated
  request), so a single missing or malformed var makes every authenticated API route answer
  500. Set them all before the first request; the full list is `ServerSchema` in `src/env.ts`.
- **`NEXT_PUBLIC_ALCHEMY_HTTP_URL` is baked in at build time and ships to the browser.** It must
  be set when `next build` runs, not only at runtime, and its Alchemy key is public: restrict
  that key by domain (kuravault.xyz) in the Alchemy dashboard. Keep the server-only
  `ALCHEMY_HTTP_URL` / `ALCHEMY_WS_URL` on a separate, unrestricted key.
- **The vendor logs in with the "wallet" method, using the vendor EOA** (`vendor` in
  `src/generated/deployments.json`). Vendor-only routes compare the Privy user's wallet with
  that address. The server prefers a Privy embedded wallet when the user has one
  (`requireUser` in `src/lib/auth.ts`), so an email or Google login, or any vendor account that
  has picked up an embedded wallet, is refused.
- **Deployments come from `pnpm sync:deployments`.** The server refuses to sign tickets or
  appraisals, or to gate vendor routes, while `src/generated/deployments.json` is the
  zero-address placeholder, and refuses to sign when `SIGNER_PRIVATE_KEY` is not the
  deployment's `signer`.

## Deploying on Vercel

The web app runs on Vercel; Postgres and the Ponder indexer stay on Railway. Set the Vercel
project's Root Directory to `apps/web` (the workspace's `pnpm-lock.yaml` is picked up from the
repo root).

### Card index on Vercel Blob

The index is ~37 MB and git-ignored, so it is not in the deployment. Host it on Vercel Blob:

1. **Create a Blob store.** Vercel dashboard > Storage > Create > Blob, then connect it to the
   project. Private access is the default and what we use: the index is only readable with the
   store's token, and connecting the store makes Vercel inject `BLOB_READ_WRITE_TOKEN` into the
   project's functions, which the loader uses. Copy the token (the store's `.env.local` tab) for
   the upload.
2. **Upload the index** (built locally with `build:index`):

       BLOB_READ_WRITE_TOKEN=vercel_blob_rw_... pnpm --filter web upload:index

   It reads `data/card-index/` (or `--dir DIR`), gzips `meta.json`, and uploads
   `manifest.json`, `meta.json.gz` and `vectors.bin` under
   `card-index/<builtAt>-<content hash>/`, then prints the env to set. Uploads are private
   unless `CARD_INDEX_BLOB_ACCESS=public` is set, and the access must match the store's (a
   private store refuses public uploads, and the other way round). Each upload is a new,
   immutable prefix (a re-upload of the same index reuses its prefix), so an old deployment
   keeps working while a new one points at the new index; delete old prefixes by hand in the
   dashboard. The manifest is uploaded last, so an interrupted upload never looks complete.
3. **Set the printed env** in the Vercel project (Settings > Environment Variables) and
   redeploy. For a private store that is

       CARD_INDEX_URL=https://<store>.private.blob.vercel-storage.com/card-index/20260925T150908Z-1a2b3c4d
       CARD_INDEX_BLOB_ACCESS=private

   and `BLOB_READ_WRITE_TOKEN` must be present too (it is when the store is connected to the
   project; otherwise add it by hand). With a private store the server reads each file through
   `@vercel/blob`'s `get` with that token; without the token every scan answers 503
   `INDEX_UNAVAILABLE` and the server logs `BLOB_READ_WRITE_TOKEN is not set`. A
   `*.private.blob.vercel-storage.com` URL is treated as private even without
   `CARD_INDEX_BLOB_ACCESS`. For a public store only `CARD_INDEX_URL` is needed, and the files are
   fetched without a token. When `CARD_INDEX_URL` is set, `CARD_INDEX_DIR` is ignored.

**Cold-start cost.** The index is loaded on the first `/api/scan/match` request a function
instance serves, not at boot, and kept in memory for as long as the instance stays warm; concurrent
first requests share one download. That download is ~24 MB (`meta.json.gz` ~4.9 MB, down from
17.5 MB, plus `vectors.bin` 19.3 MB, which is int8 and does not compress), then ~30 ms to gunzip
and ~40 ms to parse the 49,722 rows (measured locally), and about 60 MB of heap per instance. Expect
the first scan on a cold instance to take roughly one to a few seconds longer than the rest. The
load gives up after 20 s and answers 503 `INDEX_UNAVAILABLE`; a failed load is not cached, so the
next request retries.

### Function bundle notes

- **transformers.js stays out of server functions.** The Turbopack `resolveAlias` in
  `next.config.ts` stubs `@huggingface/transformers` everywhere but the browser build, so
  neither it nor `onnxruntime-node` is bundled or traced into any function (checked in
  `.next/server/**/*.nft.json`). Vercel builds with `next build`, which is Turbopack in Next
  16; do not switch the project to `next build --webpack` (see above). Both packages are also on
  Next's built-in `serverExternalPackages` list, which only matters if the alias is ever removed:
  they would then be traced into the function (the onnxruntime-node package is ~290 MB with every
  platform's binaries).
- **The local index is excluded from tracing.** The disk loader's `join(dir, "meta.json")` made
  output tracing copy `data/card-index/*` and the test fixture into the `/api/scan/match`
  function (~39 MB; 2.4 MB without them); `outputFileTracingExcludes` in `next.config.ts` drops
  them. A git-triggered Vercel build never has the index, but a `vercel deploy --prebuilt` or a
  `vercel` CLI upload from a machine that has one would have shipped it.
- **sharp** is traced into Next's server (`next-server.js.nft.json`) for image optimization,
  as in any Next app (it comes in as Next's optional dependency). The app does not use
  `next/image`, and on Vercel image optimization runs on the platform anyway. No action needed.
- **Size limits.** A Vercel function may be at most 250 MB uncompressed (including traced
  `node_modules`), and a request or response body at most 4.5 MB. The match route only receives a
  384-number vector, well under that. The in-memory index needs no special memory setting at the
  default function size.
