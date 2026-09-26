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

## Prices, cron and live toasts

- **Price routes** (public, all priced by the one rule in `src/lib/pricing.ts`: the card's finish, the
  condition multiplier, and the English printing when the card's own printing has no USD price):
  - `GET /api/cards/[id]/price`: the current quote for one card.
  - `GET /api/cards/prices?ids=1,2,3`: the same quote for up to 100 cards in one request (Explore, the
    analytics dashboard); answers are memoised for 45 s (`src/lib/price-memo.ts`).
  - `GET /api/cards/[id]/market`: the card's daily market price history from `market_prices`, empty until
    the first cron run.
- **Daily cron.** `vercel.json` schedules `GET /api/cron/prices` at 03:00 UTC. It writes one `market_prices`
  row per vault card printing and UTC day. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`, so set
  `CRON_SECRET` in the Vercel project; without it the route answers 401 to everyone.
  - **ENS appraisals.** With `APPRAISER_WRITE_ENS=true`, the cron also publishes `appraisal.usd` and
    `appraisal.at` on the ENS name of every sharded card, and every card in a live auction (on purpose: a
    market reference while it runs), that has a USD price: the whole card's market price at its finish and
    condition, the value a buyout appraisal publishes. It goes through the buyout's write path in
    `src/lib/appraise.ts` (`publishAppraisalRecord`: one write queue, a per-card advisory lock with a claim
    row in `app.ens_appraisal_writes`, the pending nonce with one retry, no send while an appraisal write over
    two minutes old is unmined with txs pending behind it, and a rewrite only on a price change or after an hour). Whole and released cards are skipped.
    Per run it writes at most `MAX_ENS_WRITES_PER_RUN` (20) records, none while the signer holds under
    0.003 ETH, and it stops starting writes after one times out, finds the signer stuck or runs out of funds.
    It needs `SIGNER_PRIVATE_KEY` (the appraiser; at 1 gwei 0.02 ETH covers about 250–330 writes),
    `APPRAISER_WRITE_ENS`, `ALCHEMY_HTTP_URL` and `CRON_SECRET` in Vercel. A failed write is logged and
    counted, never failing the snapshot: the route answers `{ updated, total, appraised, appraisalErrors }`,
    plus `partial: true` when it stopped at its 50 s budget or left writes for the next run.
- **Migration.** `drizzle/0004_market_price_etched.sql` adds `market_prices.usd_etched`. Apply it with
  `pnpm --filter web db:migrate` against the production `DATABASE_URL` before the cron runs; until then
  every snapshot insert fails. `drizzle/0005_ens_appraisal_writes.sql` adds `app.ens_appraisal_writes`,
  the ENS write claims; apply it before enabling `APPRAISER_WRITE_ENS`.
- **Live toasts.** `NEXT_PUBLIC_ALCHEMY_WS_URL` (an Alchemy Sepolia `wss://` URL) lets signed-in pages
  watch `BidSubmitted`, `AuctionSettled` and `CardRedeemed` and toast them (`src/hooks/use-live-events.ts`).
  Like the HTTP URL it is baked in at build time and ships to the browser. Without it the toasts are off
  and everything else still updates through the indexer's live queries.

## MultiBaas (Curvegrid)

Optional. Without these variables the dashboard reads the indexer alone ("Data: indexer"), the recent-events panel is
hidden, and the webhook answers 503. None of them is in `ServerSchema` (`src/env.ts`), so a missing one never breaks
another route.

| Variable | Where | What |
|---|---|---|
| `MULTIBAAS_URL` | server | The deployment's base URL, `https://<deployment>.multibaas.com` (no `/api/v0`; https only, otherwise it counts as unset) |
| `MULTIBAAS_API_KEY` | server | A MultiBaas API key (Bearer JWT). Never `NEXT_PUBLIC_`: it is read only in `src/lib/multibaas/server.ts` and the setup script |
| `MULTIBAAS_WEBHOOK_SECRET` | server | The `kura_web` webhook's signing secret, printed once by `pnpm multibaas:setup --apply --webhook-base https://www.kuravault.xyz` (again with `--show-secret`) |

Set all three in Vercel (Production) and redeploy. Locally the web app reads `apps/web/.env.local`, while the setup
script reads the repo root's `.env`, so the dev server needs them in `apps/web/.env.local` too.

- **Plan limits.** Our plan syncs past logs at most 100 blocks back, keeps events for 72 h, returns at most 50 rows per
  page (`MB_PAGE` in `packages/shared/src/multibaas.ts`; a larger `limit` answers 400), allows 30,000 API calls a month
  and has `GET /events` disabled. Everything below follows from that.
- **Setup.** From the repo root:
  - `pnpm multibaas:setup --webhook-base https://www.kuravault.xyz` prints the plan (GETs only; the client refuses any
    other method without `--apply`).
  - `--apply` uploads the CardVault ABI as `kura_cardvault` 1.0 (ABI only, `bin` `"0x"`), aliases the vault as
    `kura_vault` and links it, puts the six Event Queries (input fields carry their `inputIndex`) and creates or
    repoints the webhook. The deploy block is out of the plan's reach, so the link starts at `startingBlock` `"-95"`:
    earlier vault history is only in the Ponder indexer.
  - `--verify` prints the vault's indexing status, each query's sample rows with their value types, and the webhook's
    recent deliveries. `--show-secret` prints the existing webhook's secret.
  - The script is idempotent: rerunning it changes only what differs, and prints "nothing to do" when it is set up.
- **Dashboard.** `GET /api/analytics/multibaas?range=24h` (public, no-store) answers raised, fees, mints and volume with
  amounts as decimal strings. `?view=recent` answers the newest vault events MultiBaas holds (at most 10) and since when
  it indexes the vault, for the "Recent vault events · via MultiBaas" panel. Both read one server-side snapshot of the
  four row queries, memoised for 20 minutes (`FIGURES_TTL_MS`), failures included; a load costs 6 calls, or 2 when the
  chain or indexing check fails: about 430 calls a day per server process (about 145 while a check keeps failing). `range=7d` and `range=all` answer 503 `RANGE_UNSUPPORTED` without calling MultiBaas.
  The 24h figures answer 503 `UNAVAILABLE` (logged with the reason) until MultiBaas has indexed a whole day after the
  link, and whenever MultiBaas is down, slow (4.5 s for the load), on another chain, unlinked, still syncing, missing a
  query, or returns unexpected values; the tiles then read the indexer. The client polls every 20 minutes, not on
  window focus, and gives up after 6 s. The `add` aggregates `kura_raised_total` and `kura_fees_total` are set up but
  not read, since they would sum only the retained 72 h.
- **Webhook.** `POST /api/webhooks/multibaas` answers 503 while `MULTIBAAS_WEBHOOK_SECRET` is unset (MultiBaas
  retries) and 413 for a body over 1 MiB. It verifies `X-MultiBaas-Signature` (HMAC-SHA256 of the raw body followed by
  `X-MultiBaas-Timestamp`) and refuses timestamps more than 600 s off (401). Only CardVault events count. Each
  `AuctionSettled` log is claimed once in `app.multibaas_deliveries`, with the claim's `attempts` as its token so a
  stale handler can't overwrite a newer claim; a claim stuck in `processing` for 5 minutes is taken over. On a graduated
  settle it publishes the card's `appraisal.usd` / `appraisal.at` through `publishAppraisalRecord`, at most five per POST
  and none after 15 s (the rest are left to the daily cron), and only with `APPRAISER_WRITE_ENS=true` and the signer
  above 0.003 ETH. Any CardVault event in a POST drops the dashboard's MultiBaas snapshot
  (`invalidateMultibaasFigures`). A failure it can retry answers 503, so MultiBaas redelivers.
- **Migrations.** `drizzle/0006_multibaas_deliveries.sql` adds `app.multibaas_deliveries`; the webhook's appraisals also need 0005's
  `app.ens_appraisal_writes`. Both are applied on Railway; for another database run
  `pnpm --filter web db:migrate` before creating the webhook.

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
