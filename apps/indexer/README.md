# Kura indexer

Ponder indexer for the Kura contracts on Sepolia. Tables: cards, shardings, active_auctions, shard_balances,
shard_transfers, bids, auction_ticks, checkpoints, fee_events, payout_claims, activities, ens_names, ens_records,
ens_record_links, ens_resolver_records, collectors, bidder_bindings.

    pnpm sync:deployments          # copies contracts/deployments/sepolia.json into generated/
    cp .env.example .env.local     # set PONDER_RPC_URL_11155111 (Ponder loads .env.local, not .env)
    pnpm dev                       # local PGlite
    pnpm start --schema kura_x --views-schema kura   # Postgres via DATABASE_URL

Without `DATABASE_URL` set, `ponder start` (like `ponder dev`) falls back to PGlite writing to local disk. On
Railway that disk is ephemeral, so any deployed `start` needs `DATABASE_URL` pointed at real Postgres, or the
indexed data disappears on every restart or redeploy.

GraphQL at /graphql, SQL over HTTP at /sql, status at /status.

## Railway

Deploy config lives in `railway.json`. In the Railway dashboard:

- Service root directory: `/` (the monorepo root), config file path: `apps/indexer/railway.json`.
- Variables: `DATABASE_URL` (reference the Postgres service), `PONDER_RPC_URL_11155111`, optionally
  `PONDER_WS_URL_11155111`. `PONDER_RPC_URL_11155111` and the public Sepolia RPC fallback are load-balanced across
  (Ponder round-robins requests over the configured array), not a strict primary/fallback pair, so don't rely on the
  public endpoint only kicking in when the configured one is down.
- The start command runs `ponder start --schema $RAILWAY_DEPLOYMENT_ID --views-schema kura`, so each deployment
  indexes into its own schema and the `kura` views schema points at the live one once it is ready. Schema names are
  capped at 45 characters; if `ponder start` rejects the deployment id, use a short POSIX-safe prefix of the commit
  SHA instead of the bash-only `${RAILWAY_GIT_COMMIT_SHA:0:8}` slice, e.g.
  `--schema "kura_$(echo "$RAILWAY_GIT_COMMIT_SHA" | cut -c1-8)"`.
- Each old deployment gets its own schema and those pile up in Postgres over time once the `kura` view has moved on
  to a newer one; run `ponder prune` to drop the schemas that are no longer referenced.
- The healthcheck hits `/ready`, which only returns 200 after the historical backfill, hence the one-hour timeout.

Never run `pnpm dev` against the shared database.
