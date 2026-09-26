# ETHGlobal Tokyo 2026 submission checklist

Tick each item before submitting. Anything marked *(you)* needs a person: an account, a phone or a form.

## ETHGlobal project page *(you)*

- [ ] Project name: Kura
- [ ] Short description: vault-backed Magic: The Gathering cards you can split into shards, sell in a Uniswap CCA auction gated by World ID, and buy back whole.
- [ ] Long description (from the README pitch and "How it works")
- [ ] How it's made: Foundry contracts on Sepolia (CardVault, ShardToken, BidGateHook, CardNames), Uniswap CCA v2.1.0, World ID IDKit 4, ENSv2, Next.js on Vercel, Ponder and Postgres on Railway, Privy wallets, Scryfall pricing
- [ ] Public GitHub repository link: https://github.com/PaoloRollo/kura, with `main` up to date
- [ ] Live demo link: https://kuravault.xyz
- [ ] Demo video (2–4 minutes, following `docs/demo-script.md`)
- [ ] Screenshots or cover image (see below)
- [ ] Sponsor prizes selected: Uniswap, World, ENS, Curvegrid
- [ ] Team members and handles

## Repository

- [ ] Public repo, commit history across the weekend
- [ ] `README.md`: pitch, architecture, live deployments, contract addresses (same as `contracts/deployments/sepolia.json`), analytics, per-sponsor sections with file pointers, known limitations
- [ ] Every README file and line pointer opens the right code on GitHub
- [ ] `FEEDBACK.md` (Uniswap)
- [ ] No secrets committed: `.env*` files are git-ignored, and `.env.example` has empty values only

## Per-sponsor prize forms *(you)*

- [ ] **Uniswap:** Developer Feedback Form submitted, linking `FEEDBACK.md`; README points at `CardVault.shardAndAuction`, `BidGateHook.validate`, `CardVault.settle` and the Permit2 bid flow in `bid-form.tsx`
- [ ] **World:** README World section, with the credentials (Proof of Human for bids, Passport for release), the success and refusal paths, and the integration debrief (time to first success, friction, missing capability, one improvement). The demo shows a success and a refusal.
- [ ] **ENS:** README ENS section (registry, resolver, EAC grants, non-transferable and revocable card names, collector handles, the `appraiser.kura.eth` agent and its `appraisal.*` records), live link, open source
- [ ] **Curvegrid:** README Curvegrid section (summary, team and handles, setup and tests, MultiBaas not used)

## Live URLs

- [ ] https://kuravault.xyz loads, and `/app`, `/app/analytics` and `/vendor` work signed in
- [ ] https://indexer-production-29fa.up.railway.app/ready returns 200, and `/status` shows Sepolia near the chain head
- [ ] `https://kuravault.xyz/api/health` is OK

## Vercel environment *(you)*

- [ ] Every server variable in `apps/web/src/env.ts` is set (a missing one makes every authenticated route answer 500)
- [ ] `CRON_SECRET` is set, and the daily `/api/cron/prices` cron shows up under Settings → Cron Jobs
- [ ] `NEXT_PUBLIC_ALCHEMY_WS_URL` is set for the live toasts (then redeploy: it is baked in at build time)
- [ ] `NEXT_PUBLIC_WORLD_ENV` and `WORLD_ENV` are `staging`, and `WORLD_STAGING_VERIFICATION_TOKEN` holds a token from a staging window that is open through the judging (the current window closes 2026-09-27 04:23:41 UTC). Before the demo, re-check it with the World Developer Portal's `get_app_config` and reopen it (`set_world_id_staging_verification`) if it has closed or will close during judging; if that issues a new token, update `WORLD_STAGING_VERIFICATION_TOKEN` in Vercel and redeploy
- [ ] `APPRAISER_WRITE_ENS=true`, and the signer `0x3Ee6…b731` still holds Sepolia ETH for the ENS writes (buyout appraisals and the daily cron's appraisals; `SIGNER_PRIVATE_KEY` and `ALCHEMY_HTTP_URL` are set)
- [ ] After the first cron run, its response or logs show `appraised` > 0, and a sharded card's On-chain profile lists `appraisal.usd` and `appraisal.at`
- [ ] The card index: `CARD_INDEX_URL`, `CARD_INDEX_BLOB_ACCESS=private` and the connected Blob store's `BLOB_READ_WRITE_TOKEN`

## Railway

- [ ] The indexer service is healthy on the latest deployment
- [ ] Migration `apps/web/drizzle/0004_market_price_etched.sql` (`market_prices.usd_etched`) is applied to the production database (`pnpm --filter web db:migrate`)

## Rehearsal *(you)*

- [ ] `pnpm rehearse` prints the plan; the deployer holds the USDC it asks for (https://faucet.circle.com, Ethereum Sepolia)
- [ ] `SEED_MNEMONIC` is set in `.env` and backed up
- [ ] `pnpm rehearse --broadcast` completed on: ____ (date and time)
- [ ] `scripts/seed/sepolia.json` is committed, and its card ids are filled into `docs/demo-script.md`
- [ ] `pnpm rehearse --dry-run` passes on the demo laptop on the day

## Screenshots to capture *(you)*

- [ ] Landing, `https://kuravault.xyz` (`VOzoC`), for the README header and the cover image
- [ ] Analytics dashboard, `/app/analytics` (`Y1eNn`)
- [ ] Card analytics tab, `/app/cards/<id>?tab=analytics` (`LqnA2`)
- [ ] Scanning station mid-scan (`iRZ36`) and mint success with the ENS name (`anR2F`)
- [ ] Bid with World ID (`aD9is`) and the refusal (`p5hrR`)
- [ ] Handover confirmed (`ykB2t`)

Put them in `docs/images/` and replace the `<!-- screenshot: … -->` markers in `README.md`.
