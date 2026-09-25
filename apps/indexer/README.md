# Kura indexer

Ponder indexer for the Kura contracts on Sepolia. Tables: cards, shardings, shard_balances, shard_transfers, bids,
auction_ticks, fee_events, payout_claims, activities, ens_names, ens_records, collectors, bidder_bindings.

    pnpm sync:deployments          # copies contracts/deployments/sepolia.json into generated/
    cp .env.example .env           # set PONDER_RPC_URL_11155111
    pnpm dev                       # local PGlite
    pnpm start --schema kura_x --views-schema kura   # Postgres via DATABASE_URL

GraphQL at /graphql, SQL over HTTP at /sql, status at /status.

## Railway

Deploy config lives in `railway.json`. In the Railway dashboard:

- Service root directory: `/` (the monorepo root), config file path: `apps/indexer/railway.json`.
- Variables: `DATABASE_URL` (reference the Postgres service), `PONDER_RPC_URL_11155111`, optionally
  `PONDER_WS_URL_11155111`.
- The start command runs `ponder start --schema $RAILWAY_DEPLOYMENT_ID --views-schema kura`, so each deployment
  indexes into its own schema and the `kura` views schema points at the live one once it is ready. Schema names are
  capped at 45 characters; if `ponder start` rejects the deployment id, use
  `--schema kura_${RAILWAY_GIT_COMMIT_SHA:0:8}` instead.
- The healthcheck hits `/ready`, which only returns 200 after the historical backfill, hence the one-hour timeout.

Never run `pnpm dev` against the shared database.
