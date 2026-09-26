# Kura 蔵

**Vault-backed Magic: The Gathering cards you can split, trade and redeem on-chain.**

*Kura* (蔵) is the Japanese storehouse where merchants kept their most valuable goods. Kura does the same for trading cards:
- A trusted vendor keeps the physical card in a vault and mints a digital twin to its owner.
- The owner can split that twin into shards and sell them in a fair on-chain auction.
- Anyone who gathers 80% of the shards can buy out the rest and take the card home.

Built for **ETHGlobal Tokyo 2026**.

<!-- screenshot: landing page (VOzoC) at https://kuravault.xyz -->

---

## How it works

```
 Vendor scans card ──► CardVault mints ERC-721 twin ──► Owner
                                                          │
                              shardAndAuction (16–512 shards)
                                                          ▼
                        Uniswap CCA auction  ◄── bids gated by World ID (proof of human)
                                                          │ settle
                                                          ▼
              Vendor fee + owner proceeds (USDC)     Shard holders (ERC-20)
                                                          │
                          holder with ≥ 80% redeems at max(clearing price, appraisal)
                                                          ▼
               Minority holders claim USDC pro rata   Card is whole again
                                                          │
                          vendor releases the physical card (World ID Passport)
```

1. **Vault** (`CardVault.mint`). The vendor scans a card at the station. The app identifies it against Scryfall and records its condition, language and printing, then mints an ERC-721 to the owner. The physical card never leaves the vendor's vault until it is released.
2. **Shard** (`CardVault.shardAndAuction`). The owner splits the card into 16 to 512 shards, in multiples of 16. Each sharding deploys its own ERC-20 `ShardToken`.
3. **Auction.** The shards are sold through a **Uniswap Continuous Clearing Auction** (CCA v2.1.0), priced in Circle USDC.
   - Four durations are offered: 5 minutes, 1 day, 1 week or 1 month.
   - Every bid (`submitBid` on the auction) must carry a signed **World ID proof-of-human** ticket, so one human gets one bidding wallet.
4. **Settle** (`CardVault.settle`). When the auction ends, anyone can settle it. The proceeds go to the owner minus the vendor's fee (2.5% on this deployment, capped at 10%), and unsold shards go back to the owner. Bidders then `exitBid` (or `exitPartiallyFilledBid`) and `claimTokens` on the auction.
5. **Buy out** (`CardVault.redeem`, `CardVault.claimPayout`). A holder with at least 80% of the shards can redeem the whole card.
   - The price per shard is the higher of the auction's clearing price and a fresh appraisal signed by the vendor, based on Scryfall market data. The redeemer pays for every shard they don't hold, plus the vendor fee.
   - Every other holder then claims their USDC pro rata. Each sharding has its own payout pool, so a card can be sharded, bought out and sharded again without earlier holders ever losing their claim.
6. **Release** (`CardVault.confirmRelease`). The holder of a whole card can collect the physical card. The vendor confirms the handover with a single-use **World ID Passport** ticket bound to the holder's wallet. The card's ENS name is then revoked.

## Architecture

```
                 Browser (collector app /app, vendor station /vendor)
                   │  Privy embedded wallets · IDKit · wagmi/viem · live queries
                   ▼
   ┌──────────────────────────── Vercel: Next.js (apps/web) ────────────────────────────┐
   │ /api/worldid/verify ─► World Developer Portal (verify)  ─► signs EIP-712 tickets     │
   │ /api/appraise        ─► Scryfall prices (lib/pricing)    ─► signs appraisals,        │
   │                                                             writes appraisal.* ENS  │
   │ /api/scan/match      ─► card image index (private Vercel Blob)                       │
   │ /api/cron/prices     ─► daily market_prices snapshots, appraisal.* ENS (sharded)     │
   └───────┬──────────────────────────────────────┬───────────────────────────────┬──────┘
           │ Drizzle                               │ @ponder/client (SQL over HTTP)│ txs / reads
           ▼                                       ▼                               ▼
   Railway Postgres (app schema:          Railway: Ponder indexer          Ethereum Sepolia
   tickets, appraisals, prices,  ◄──────  (apps/indexer) ◄──── events ──── CardVault · ShardToken
   release tickets)                        cards, bids, checkpoints,        BidGateHook · CardNames
                                           holders, fees, ENS records       Uniswap CCA · Permit2 · USDC
                                                                            ENSv2 registry + resolvers
```

## Live deployments

| What | Where |
|---|---|
| Web app (Vercel) | [https://kuravault.xyz](https://kuravault.xyz): collector app at `/app`, vendor station at `/vendor`. This is also the vault's on-chain `siteURI` (`https://kuravault.xyz/app/cards/`). |
| Indexer (Ponder on Railway) | [https://indexer-production-29fa.up.railway.app](https://indexer-production-29fa.up.railway.app): SQL over HTTP at `/sql`, GraphQL at `/graphql`, status at `/status`. |
| Card image index | A private Vercel Blob store, read by `/api/scan/match` with the store's token (see [`apps/web/README.md`](apps/web/README.md)). |
| Contracts | Ethereum Sepolia; addresses below. |

## ENS names (ENSv2)

Every card lives under `kura.eth` on ENSv2:

| Name | Example | Notes |
|---|---|---|
| Card | `black-lotus-lea-1.kura.eth` | `<card-slug>-<set-code>-<tokenId>`. Non-transferable and revoked on release. Records hold state, owner, language, condition and the latest clearing price and appraisal. |
| Collector | `paolo.kura.eth` | Handles use `a-z0-9` only, 3 to 32 characters. There are no dashes, so they can never collide with card names. |
| Appraiser | `appraiser.kura.eth` | Resolves to the key that signs appraisals and tickets. |

The vendor and the appraiser get write rights to specific record keys on specific names. For example, the vendor can set `condition` but not `vault.state`, and card holders can't edit records at all.

## Deployed contracts (Ethereum Sepolia, chain id 11155111)

| Contract | Address |
|---|---|
| CardVault (ERC-721) | [`0x62FB23ec64994F658E9DD4E0FC223DdF8a7D62c2`](https://sepolia.etherscan.io/address/0x62FB23ec64994F658E9DD4E0FC223DdF8a7D62c2) |
| ShardMarket (Uniswap v4 hook, seeds and holds each card's pool) | [`0x6812fA7Dd04108cf39D0205BA52E5665Ca40A8c0`](https://sepolia.etherscan.io/address/0x6812fA7Dd04108cf39D0205BA52E5665Ca40A8c0) |
| CardNames (ENSv2 adapter) | [`0x0CE01d29746f65360c4e0ad6a3644D66Cc2b8c0D`](https://sepolia.etherscan.io/address/0x0CE01d29746f65360c4e0ad6a3644D66Cc2b8c0D) |
| BidGateHook (CCA validation hook) | [`0x747190Bf3BC832f98326728ae778E954B1E7CE1e`](https://sepolia.etherscan.io/address/0x747190Bf3BC832f98326728ae778E954B1E7CE1e) |
| `kura.eth` registry (ENSv2 UserRegistry) | [`0xc565c77715671BF6b43A69E7CdBa24c822Cc6400`](https://sepolia.etherscan.io/address/0xc565c77715671BF6b43A69E7CdBa24c822Cc6400) |
| `kura.eth` resolver (ENSv2 PermissionedResolver) | [`0x807BDD92fD47579a22E12289C089A55Ee52821aC`](https://sepolia.etherscan.io/address/0x807BDD92fD47579a22E12289C089A55Ee52821aC) |

These roles and external contracts are used by the deployment:

| Role / dependency | Address |
|---|---|
| Vendor | [`0x7aD58bd97A7cd456dC854B1cEc95eC80f6F4F9fe`](https://sepolia.etherscan.io/address/0x7aD58bd97A7cd456dC854B1cEc95eC80f6F4F9fe) |
| Ticket and appraisal signer (`appraiser.kura.eth`) | [`0x3Ee6A2194D10f199E5271a72Dd3ba8F64DE3b731`](https://sepolia.etherscan.io/address/0x3Ee6A2194D10f199E5271a72Dd3ba8F64DE3b731) |
| Uniswap CCA factory (v2.1.0) | [`0x000000001F26a0044BaA66024e7b6599c61963F8`](https://sepolia.etherscan.io/address/0x000000001F26a0044BaA66024e7b6599c61963F8) |
| Permit2 | [`0x000000000022D473030F116dDEE9F6B43aC78BA3`](https://sepolia.etherscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |
| USDC (Circle, Sepolia) | [`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`](https://sepolia.etherscan.io/address/0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238) |
| ENSv2 ETHRegistry | [`0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E`](https://sepolia.etherscan.io/address/0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E) |
| ENSv2 UniversalResolverV2 | [`0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3`](https://sepolia.etherscan.io/address/0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3) |
| ENSv2 VerifiableFactory | [`0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C`](https://sepolia.etherscan.io/address/0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C) |
| ENSv2 PermissionedResolver implementation | [`0x14F09Fd05d4585759e54844DC9B00147131Cf243`](https://sepolia.etherscan.io/address/0x14F09Fd05d4585759e54844DC9B00147131Cf243) |

- **Deploy block:** 11779719.
- **Machine-readable copies:** [`contracts/deployments/sepolia.json`](contracts/deployments/sepolia.json) and [`contracts/deployments/sepolia.ens.json`](contracts/deployments/sepolia.ens.json). The web app and the indexer read these through `@kura/shared`.

## Analytics and real-time

<!-- screenshot: analytics dashboard (Y1eNn) at https://kuravault.xyz/app/analytics -->
<!-- screenshot: card analytics tab (LqnA2) at https://kuravault.xyz/app/cards/<id>?tab=analytics -->

`/app/analytics` shows the whole vault, and every card page has an Analytics tab. All numbers come from the indexer, and market prices always come from `apps/web/src/lib/pricing.ts` (the Scryfall price for the card's finish, times the condition multiplier). The definitions live in [`apps/web/src/lib/metrics.ts`](apps/web/src/lib/metrics.ts):

| Metric | Rule |
|---|---|
| Implied value | Price per shard × total shards. For a settled auction the price is its clearing price, and a sharding whose auction **did not graduate** reads **n/a** (the contract still records a clearing price then, so n/a is decided from `graduated`, never from a zero price). A live auction uses its latest checkpoint's clearing price, labelled "live" on the card page and in the dashboard's premiums and market map. |
| Premium | Implied value ÷ market price − 1. n/a when either is missing. |
| Concentration (HHI) | Σ share² over the holders who aren't custodians (the auction and the vault). 1.0 means one owner. |
| Distance to redemption | How far the top holder is from the 80% rule, measured against the **full** `ShardToken.totalSupply()` (shards still in the auction count, as `redeem` counts them). Shown as "eligible" or "N.N shards short": 10 of 16 shards is 2.8 shards short, since 80% of 16 is 12.8. |
| Fill rate | Shards sold ÷ shards for sale. Sold = for sale minus the unsold shards swept back to the vault at settle; a non-graduated auction sold 0; a live auction uses the latest `totalCleared`. |
| Participation | Distinct bidding wallets. `BidGateHook` binds one World ID nullifier to one wallet, so this counts unique humans. |
| Volume | Graduated settles plus buyouts, bucketed hourly for 24h and daily for 7d and All. |
| Fees | `FeeAccrued` events, split into sale and buyout. |

Real-time:
- Pages read the indexer through Ponder live queries, so bids, settles and transfers appear without a reload.
- With `NEXT_PUBLIC_ALCHEMY_WS_URL` set, signed-in pages also watch `BidSubmitted`, `AuctionSettled` and `CardRedeemed` over a websocket and show a toast (`apps/web/src/lib/live-events.ts`). Your own transactions are not toasted again.
- The bell in the top bar derives notifications from the indexer: outbid, payout ready, ending soon, your auction settled, shards received and redemption unlocked (`apps/web/src/lib/notifications.ts`).
- A daily Vercel cron snapshots market prices for the price history and publishes the ENS appraisal of each sharded or auctioning card (`apps/web/src/app/api/cron/prices/route.ts`).

## Sponsor tech

### Uniswap: Continuous Clearing Auction

Every shard sale is a CCA v2.1.0 auction, created and settled by the vault.
- **Creating the auction:** [`CardVault.shardAndAuction`](contracts/src/CardVault.sol#L271-L323) deploys the `ShardToken`, calls the CCA factory's `create` (line 288), mints the shards for sale into the auction and calls `onTokensReceived`. [`_auctionParams`](contracts/src/CardVault.sol#L326-L343) sets the vault as both the tokens and the funds recipient, puts the floor on an exact tick, and builds the release schedule with [`AuctionSteps.linear`](contracts/src/libraries/AuctionSteps.sol#L22-L28).
- **Gating bids:** [`BidGateHook.validate`](contracts/src/BidGateHook.sol#L30-L43) is the auction's validation hook. It decodes a signed ticket from `hookData`, checks the kind, the subject and the signature, and binds the World ID nullifier to the first wallet that bids with it. The web encodes that `hookData` in [`encodeHookData`](apps/web/src/lib/tx-core.ts#L26-L35).
- **Bidding through Permit2:** [`bid-form.tsx`](apps/web/src/components/bid-form.tsx#L119-L147) runs three steps: approve USDC to Permit2 once, `permit2.approve` the auction for the budget, then `submitBid` with the ticket. Hook reverts arrive wrapped in `ValidationHookCallFailed(bytes)`; [`decodeRevert`](apps/web/src/lib/tx-core.ts#L135-L158) unwraps the inner `BidGateHook` error, so an expired ticket asks for a new World ID check and `AlreadyBound` explains the one-wallet rule.
- **Settling:** [`CardVault.settle`](contracts/src/CardVault.sol#L360-L396) calls `sweepUnsoldTokens` (returned to the owner) and, when the auction graduated, `sweepCurrency`, then pays the vendor fee and forwards the rest to the owner.
- **Exits:** [`exitRoute`](apps/web/src/lib/bid-math.ts#L61-L68) picks `exitBid` or `exitPartiallyFilledBid` with checkpoint hints computed from the indexed `CheckpointUpdated` events ([`apps/indexer/src/auction.ts`](apps/indexer/src/auction.ts#L74)).
- Our integration notes for the Uniswap team are in [`FEEDBACK.md`](FEEDBACK.md).

### World: World ID (IDKit 4)

- **Widget:** [`world-id-gate.tsx`](apps/web/src/components/world-id-gate.tsx#L134-L186) opens `IDKitRequestWidget` with the `proofOfHuman` preset for bids and `passport` for release. The proof's signal is the wallet address.
- **Server verify:** [`verifyWorld`](apps/web/src/lib/world.ts#L66-L121) checks the action, the signal hash (the proof must be for this wallet), the credential and the environment, then forwards the proof to `https://developer.world.org/api/v4/verify/<rp_id>`. `/api/worldid/verify` binds one nullifier per action to one wallet in Postgres and signs an EIP-712 ticket: a 24-hour HUMAN ticket for bidding, a 15-minute PASSPORT ticket for release.
- **On-chain enforcement:** `BidGateHook.validate` (above) for bids. For release, [`CardVault.confirmRelease`](contracts/src/CardVault.sol#L467-L481) is vendor-only and requires a PASSPORT ticket whose subject is the card's current holder; each ticket works once.
- **Credentials, and why** ([`acceptedCredentials`](apps/web/src/lib/world.ts#L40-L44)):
  - Bidding accepts Proof of Human, Passport or Selfie Check. The point is one human, one bidding wallet, so an auction's price discovery can't be flooded by one person with many wallets. Bids require World ID 4.0 proofs, because legacy and v4 nullifiers differ and accepting both would let one human bind two wallets.
  - Release accepts Passport only (`WORLD_RELEASE_CREDENTIALS`). Handing over a valuable physical card warrants document-grade proof, and the holder starts the check from their own logged-in app, so the ticket is always bound to the wallet that owns the card.
- **Success path:** the proof verifies → the server signs the ticket → the bid form sends `submitBid` with it → the hook binds the nullifier on its first bid. For release, the ticket waits server-side until the vendor's station picks it up and sends `confirmRelease`.
- **Refusal paths:** World's refusals (with its per-proof codes), a proof for another wallet (`SIGNAL_MISMATCH`), a weaker credential (`WRONG_CREDENTIAL`), the wrong environment, and a World ID already bound to another wallet (`ALREADY_BOUND`, which names that wallet) each get their own message. On chain, `Expired`, `BadSignature`, `WrongSubject` and `AlreadyBound` from the hook, and `WrongTicketKind`, `TicketSubjectMismatch` and `TicketUsed` from the vault, are decoded and explained.

**Integration debrief** (app `app_0dbe3d0ca627f463a63837ee969ef4bf`, managed RP):
- *Time to first success.* The verify path was written on 25 Sep (evening, JST). The first `200` from the verify API came on 26 Sep, about 13:25 JST, once staging verification was open for the app. Most of that gap went to the two problems below.
- *Friction, production.* Passport proofs failed inside World's verifier with `passport: verification_failed (execution reverted (unknown custom error))`. We could not find the cause, and it is still unresolved, so the demo runs in the staging environment.
- *Friction, staging.* Staging proofs were first refused with `Staging verification is not open for this app`. The fix was to open a staging verification window through the World Developer Portal MCP (`set_world_id_staging_verification`) and create the staging actions `bid` and `release`. Staging proofs must then carry the window's token in an `x-staging-verification-token` header ([`world.ts`](apps/web/src/lib/world.ts#L95-L98)); after that, staging verify returned `200`.
- *Missing capability.* A verify error that names the actual cause: "staging not open" should say how to open it, and a Passport verifier revert should say which check failed instead of "unknown custom error".
- *One improvement.* Document the staging verification window and the `x-staging-verification-token` header next to the v4 verify endpoint. We found both only through the portal tooling.

### ENS: ENSv2

- **Registry and resolver:** [`SetupEns.s.sol`](contracts/script/SetupEns.s.sol#L69-L122) deploys `kura.eth`'s own ENSv2 UserRegistry and PermissionedResolver through the VerifiableFactory, then registers `kura.eth` and names the appraiser agent (lines 125–193). It targets the ENSv2 deployment on [docs.ens.domains](https://docs.ens.domains/learn/deployments) (contracts-v2 `71a3b73`), so names resolve in the ENS App and through UniversalResolverV2; [`MigrateNames.s.sol`](contracts/script/MigrateNames.s.sol) moved the live vault's names onto it.
- **Card names:** [`CardNames.registerCard`](contracts/src/CardNames.sol#L134-L159) issues `<slug>-<set>-<id>.kura.eth`, owned by the adapter itself with no transfer role ([`EnsRoles`](contracts/src/libraries/EnsRoles.sol#L38-L39)), so card names are **non-transferable**. It writes the records by DNS-encoded name in one multicall and grants scoped **EAC** per-key text roles with `grantSetterRoles`: `condition` and `grade` to the vendor, `appraisal.usd` and `appraisal.at` to the appraiser (lines 152–155). [`setState`](contracts/src/CardNames.sol#L162-L176) mirrors the vault state, shard token, auction and clearing price, and [`revoke`](contracts/src/CardNames.sol#L184-L190) unregisters the name when the card is released.
- **Collector handles:** [`registerCollector`](contracts/src/CardNames.sol#L195-L216) deploys a PermissionedResolver for the collector, with the collector as its sole admin, and registers `<handle>.kura.eth` to them.
- **Agent namespace:** `appraiser.kura.eth` resolves to the signer. With `APPRAISER_WRITE_ENS=true`, that signer publishes each appraisal on the card's name as `appraisal.usd` (the whole card's market price) and `appraisal.at`, using its EAC grant, in one resolver multicall ([`writeAppraisalText`](apps/web/src/lib/appraise.ts#L247-L295)), skipped only when the signer is stuck: an appraisal write sent over two minutes ago is still unmined and transactions are pending behind it ([`sendUnlessStuck`](apps/web/src/lib/appraise.ts#L195-L224)); a write seconds old is just in flight, and the next one queues behind it on the pending nonce. Writes are serialized: an in-process queue plus a per-card Postgres advisory lock ([`pgEnsWriteLock`](apps/web/src/lib/appraise.ts#L116-L148)), each sent with the chain's pending nonce and retried once on a nonce clash ([`sendWithFreshNonce`](apps/web/src/lib/appraise.ts#L165-L193)). Inside the lock's transaction the write is claimed in `app.ens_appraisal_writes` ([`claimEnsWrite`](apps/web/src/lib/appraise.ts#L350-L364)), so another instance, an overlapping cron run or a buyout can't send the same price again while the indexed record lags; a failed send puts the claim back (only if the row is still its own claim), a sent one records its tx hash, and a claim that never got a hash is taken over after five minutes. [`publishAppraisalRecord`](apps/web/src/lib/appraise.ts#L380-L438) skips the write unless the price changed or the record is over an hour old. Records are written on a buyout appraisal and, so every sharded card carries one without a buyout, by the daily price cron: after each card's snapshot, [`/api/cron/prices`](apps/web/src/app/api/cron/prices/route.ts) publishes the market price of every sharded card, and of every card in a live auction (on purpose: a market reference while it runs), through the same path. Whole and released cards, and cards with no USD price, are skipped. The cron writes at most 20 records per run, none while the signer holds under 0.003 ETH (buyouts keep that headroom), and stops starting writes after one times out, finds the signer stuck or runs out of funds; a failed write never fails the snapshot, and the cron reports `appraised` and `appraisalErrors`. At 1 gwei a write costs roughly 60–80k gas, so 0.02 ETH covers about 250–330 writes. On Vercel this needs `SIGNER_PRIVATE_KEY`, `APPRAISER_WRITE_ENS=true`, `ALCHEMY_HTTP_URL` and `CRON_SECRET`.

### Curvegrid: real-world asset dashboards

- **Summary.** Kura tokenizes physical trading cards held by a vendor, with on-chain provenance from mint to release, and shows the vault's market on dashboards built on its own indexer.
- **Team.** Paolo Rollo ([@PaoloRollo](https://github.com/PaoloRollo)).
- **Setup and tests:** see [Getting started](#getting-started): contracts (`forge test` on a Sepolia fork), web (`pnpm --filter web test`) and indexer (`pnpm --filter indexer test`).
- **MultiBaas.** Not used. The dashboards read our Ponder indexer ([`apps/indexer`](apps/indexer)).

## Repository layout

```
contracts/          Foundry project: CardVault, ShardToken, BidGateHook, CardNames, libraries, scripts, fork tests
packages/shared/    ABIs, EIP-712 types, ENS label rules and the deployment loader, shared by web and indexer
apps/web/           Next.js app: /vendor (scanning station, vault) and /app (collector, analytics)
apps/indexer/       Ponder indexer on Postgres: cards, shardings, bids, checkpoints, holders, fees, ENS records
scripts/            deploy-sepolia.sh, sync-deployments.mjs, rehearse.ts (demo rehearsal and seeding)
docs/               demo-script.md, submission-checklist.md
```

## Tech stack

- **Contracts:** Solidity 0.8.26, Foundry, OpenZeppelin, Uniswap CCA v2.1.0, ENSv2.
- **App:** Next.js, shadcn/ui, Privy (embedded wallets, gas sponsorship), wagmi/viem, Drizzle + Postgres, World ID IDKit.
- **Card data:** Scryfall. Cards are identified in the browser by matching image embeddings against an index of Scryfall card images.
- **Indexer:** Ponder, with GraphQL and SQL over HTTP.

## Getting started

Requirements: Node 24, pnpm 10 and Foundry.

```bash
pnpm install
git submodule update --init contracts/lib/forge-std contracts/lib/openzeppelin-contracts contracts/lib/continuous-clearing-auction contracts/lib/v4-periphery
git -C contracts/lib/v4-periphery submodule update --init lib/v4-core lib/permit2
git -C contracts/lib/v4-periphery/lib/v4-core submodule update --init lib/solmate
cp .env.example .env     # fill in what you need; .env is git-ignored
```

Fetch the submodules non-recursively as shown. The CCA's own nested submodules aren't needed to build.

### Contracts

```bash
cd contracts
forge build
SEPOLIA_RPC_URL=<your Sepolia RPC> forge test   # most suites fork Sepolia
```

The test suite runs against a Sepolia fork, using the real CCA factory, Permit2, Circle USDC and ENSv2. It includes:
- a full lifecycle test: sell → buy out → sell again → earlier holders claim → release;
- an end-to-end run of the deploy scripts.

### Deploy your own

```bash
./scripts/deploy-sepolia.sh
```

The script runs the whole sequence:
1. Registers `$VAULT_ENS_LABEL.eth`: it commits, waits for the registrar's commitment age, then registers.
2. Deploys the contracts.
3. Seeds one demo card.

You need `DEPLOYER_PRIVATE_KEY`, `VENDOR_PRIVATE_KEY`, `SIGNER_ADDRESS` and `SEPOLIA_RPC_URL` in `.env`. The deployer must be a plain EOA with Sepolia ETH. See [`contracts/README.md`](contracts/README.md) for details and operational notes.

### Web app

```bash
pnpm sync:deployments
pnpm dev                 # http://localhost:3000 — /vendor and /app
pnpm --filter web test
```

The web app needs these credentials:
- Privy: `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_SECRET`.
- World ID: `WORLD_APP_ID`, `WORLD_RP_ID` and `WORLD_RP_SIGNING_KEY`, plus `WORLD_STAGING_VERIFICATION_TOKEN` in staging.
- A Postgres `DATABASE_URL`.
- An Alchemy Sepolia URL, and optionally its websocket URL for live toasts.

Deployment notes, the price routes and the daily cron are in [`apps/web/README.md`](apps/web/README.md).

### Indexer

```bash
cd apps/indexer
cp .env.example .env.local   # PONDER_RPC_URL_11155111
pnpm dev                     # local PGlite, http://localhost:42069
pnpm test
```

See [`apps/indexer/README.md`](apps/indexer/README.md) for the Railway deployment.

### Rehearsal and demo data

`scripts/rehearse.ts` drives five real cards through every path: a buyout with minority payouts, a graduated auction, an auction that misses its reserve, a Passport release, and a card that stays whole. It then re-shards the bought-out card as a live auction with one pre-seeded bid. The wallets are synthetic `seed…kura.eth` collectors derived from `SEED_MNEMONIC`, funded by the deployer.

```bash
pnpm rehearse              # print the plan and the USDC/ETH budget; sends nothing
pnpm rehearse --dry-run    # run everything on a local anvil fork of Sepolia; nothing is broadcast
pnpm rehearse --broadcast  # real Sepolia: asks you to type BROADCAST, refuses without a terminal or in CI
```

A broadcast run is resumable (`scripts/.rehearse-state.sepolia.json`, git-ignored) and writes the seeded card ids to `scripts/seed/sepolia.json`. The demo walkthrough is [`docs/demo-script.md`](docs/demo-script.md).

## Known limitations

- **World ID runs in the staging environment.** Production Passport proofs fail inside World's verifier (see the debrief above), and the cause is unresolved.
- **A single vendor.** One vendor key mints and releases cards, and it is trusted to hold the physical cards.
- **Seeded demo data.** Part of the vault's history on Sepolia comes from the rehearsal script's synthetic `seed…kura.eth` wallets, with synthetic World ID nullifiers.
- **Testnet only.** Everything runs on Sepolia with Circle's test USDC.

## Security notes

This is a hackathon prototype on a testnet. It is not audited.
- **Trusted parties:** the vendor and the signer. A compromised signer can issue bid tickets and inflate appraisals. An inflated appraisal can only raise a buyout price, never lower what minority holders receive. The signer cannot release a card without the vendor.
- **Owner powers:** the contract owner can change the fee (at most 10%), the vendor, the signer and the names adapter. The owner cannot move vaulted NFTs or payout pools.
- **Replay protection:** tickets and appraisals are EIP-712 signed under separate domains ("Kura BidGate" and "Kura CardVault"), bound to the chain and the verifying contract. Tickets are single use.

## License

Source files are MIT-licensed (see the SPDX headers).
