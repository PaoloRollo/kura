# Kura web

Next.js app for Kura: the vendor station at /vendor and the collector app at /app.

    pnpm --filter web dev
    pnpm --filter web test

## Card image index

The scan station matches a webcam photo against a vector index built offline by
`scripts/build-card-index.mts` into `CARD_INDEX_DIR` (default `data/card-index`, see
`src/lib/card-index.ts`). That directory is git-ignored, so it is not part of the deploy
artifact — it must be built or copied onto the server separately before the scan station
will work there (see `# CARD_INDEX_DIR=` in the root `.env.example`).

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
