# Kura 蔵

**Vault-backed Magic: The Gathering cards you can split, trade and redeem on-chain.**

*Kura* (蔵) is the Japanese storehouse where merchants kept their most valuable goods. Kura does the same for trading cards:
- A trusted vendor keeps the physical card in a vault and mints a digital twin to its owner.
- The owner can split that twin into shards and sell them in a fair on-chain auction.
- Anyone who gathers 80% of the shards can buy out the rest and take the card home.

Built for **ETHGlobal Tokyo 2026**.

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

1. **Vault.** The vendor scans a card at the station. The app identifies it against Scryfall and records its condition, language and printing, then mints an ERC-721 to the owner. The physical card never leaves the vendor's vault until it is released.
2. **Shard.** The owner splits the card into 16 to 512 shards, in multiples of 16. Each sharding deploys its own ERC-20 `ShardToken`.
3. **Auction.** The shards are sold through a **Uniswap Continuous Clearing Auction** (CCA v2.1.0), priced in Circle USDC.
   - Four durations are offered: 5 minutes, 1 day, 1 week or 1 month.
   - Every bid must carry a signed **World ID proof-of-human** ticket, so one human gets one bidding wallet.
4. **Settle.** When the auction ends, anyone can settle it. The proceeds go to the owner minus the vendor's fee (2.5% on this deployment, capped at 10%), and unsold shards go back to the owner.
5. **Buy out.** A holder with at least 80% of the shards can redeem the whole card.
   - The price per shard is the higher of the auction's clearing price and a fresh appraisal signed by the vendor, based on Scryfall market data. The redeemer pays for every shard they don't hold, plus the vendor fee.
   - Every other holder then claims their USDC pro rata. Each sharding has its own payout pool, so a card can be sharded, bought out and sharded again without earlier holders ever losing their claim.
6. **Release.** The holder of a whole card can collect the physical card. The vendor confirms the handover with a single-use **World ID Passport** ticket bound to the holder's wallet. The card's ENS name is then revoked.

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
| CardVault (ERC-721) | [`0xEC598d41513A15Bb17D4FAeF5e127aB47A54f1B4`](https://sepolia.etherscan.io/address/0xEC598d41513A15Bb17D4FAeF5e127aB47A54f1B4) |
| CardNames (ENSv2 adapter) | [`0x93f5A4c05A6Ba8f785463efD3C15B34c72C63c49`](https://sepolia.etherscan.io/address/0x93f5A4c05A6Ba8f785463efD3C15B34c72C63c49) |
| BidGateHook (CCA validation hook) | [`0x572E7C7001Cc48fB18015325cF97F660056adA7E`](https://sepolia.etherscan.io/address/0x572E7C7001Cc48fB18015325cF97F660056adA7E) |
| `kura.eth` registry (ENSv2 UserRegistry) | [`0xB995ae648F54033DD955E34548a46AF9a8F083A0`](https://sepolia.etherscan.io/address/0xB995ae648F54033DD955E34548a46AF9a8F083A0) |
| `kura.eth` resolver (ENSv2 PermissionedResolver) | [`0xf6639887bF239c448c73E787a1F07E98d2af526c`](https://sepolia.etherscan.io/address/0xf6639887bF239c448c73E787a1F07E98d2af526c) |

These roles and external contracts are used by the deployment:

| Role / dependency | Address |
|---|---|
| Vendor | [`0x7aD58bd97A7cd456dC854B1cEc95eC80f6F4F9fe`](https://sepolia.etherscan.io/address/0x7aD58bd97A7cd456dC854B1cEc95eC80f6F4F9fe) |
| Ticket and appraisal signer (`appraiser.kura.eth`) | [`0x3Ee6A2194D10f199E5271a72Dd3ba8F64DE3b731`](https://sepolia.etherscan.io/address/0x3Ee6A2194D10f199E5271a72Dd3ba8F64DE3b731) |
| Uniswap CCA factory (v2.1.0) | [`0x000000001F26a0044BaA66024e7b6599c61963F8`](https://sepolia.etherscan.io/address/0x000000001F26a0044BaA66024e7b6599c61963F8) |
| Permit2 | [`0x000000000022D473030F116dDEE9F6B43aC78BA3`](https://sepolia.etherscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |
| USDC (Circle, Sepolia) | [`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`](https://sepolia.etherscan.io/address/0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238) |
| ENSv2 VerifiableFactory | [`0x118Bc31A50d559F7015a8Da26d54B3b030CdB70F`](https://sepolia.etherscan.io/address/0x118Bc31A50d559F7015a8Da26d54B3b030CdB70F) |
| ENSv2 PermissionedResolver implementation | [`0x7E4B2d59938930168024201752EE5503df402303`](https://sepolia.etherscan.io/address/0x7E4B2d59938930168024201752EE5503df402303) |

- **Deploy block:** 11779719.
- **Machine-readable copies:** [`contracts/deployments/sepolia.json`](contracts/deployments/sepolia.json) and [`contracts/deployments/sepolia.ens.json`](contracts/deployments/sepolia.ens.json). The web app and the indexer read these through `@kura/shared`.

## Sponsor tech

- **Uniswap: Continuous Clearing Auction.**
  - Every shard sale is a CCA auction. The auction creator is `CardVault.shardAndAuction`, which uses a two-step release schedule and a floor aligned to a tick.
  - Bids fund through Permit2.
  - `BidGateHook` is the auction's validation hook.
  - Settlement sweeps unsold tokens and raised currency back to the vault.
- **World: World ID (IDKit 4).**
  - Proof of human gates bidding: one nullifier binds to one wallet.
  - Passport gates the physical release.
  - The server verifies proofs with the World Developer Portal, then signs short-lived EIP-712 tickets that the contracts check.
- **ENS: ENSv2.**
  - `kura.eth` has its own ENSv2 user registry and a permissioned resolver.
  - Every card, collector and the appraiser gets a subname, and records are scoped per key.
- **Curvegrid: real-world asset dashboards.** Physical cards are tokenized with on-chain provenance, and analytics are built on the indexer.

## Repository layout

```
contracts/          Foundry project: CardVault, ShardToken, BidGateHook, CardNames, libraries, scripts, fork tests
packages/shared/    ABIs, EIP-712 types, ENS label rules and the deployment loader, shared by web and indexer
apps/web/           Next.js app: /vendor (scanning station, vault) and /app (collector)            [in progress]
apps/indexer/       Ponder indexer on Postgres: cards, shardings, bids, prices, ENS records        [in progress]
scripts/            deploy-sepolia.sh, sync-deployments.mjs
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
git submodule update --init contracts/lib/forge-std contracts/lib/openzeppelin-contracts contracts/lib/continuous-clearing-auction
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
```

The web app needs these credentials:
- Privy: `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_SECRET`.
- World ID: `WORLD_APP_ID`, `WORLD_RP_ID` and `WORLD_RP_SIGNING_KEY`.
- A Postgres `DATABASE_URL`.
- An Alchemy Sepolia URL.

## Security notes

This is a hackathon prototype on a testnet. It is not audited.
- **Trusted parties:** the vendor and the signer. A compromised signer can issue bid tickets and inflate appraisals. An inflated appraisal can only raise a buyout price, never lower what minority holders receive. The signer cannot release a card without the vendor.
- **Owner powers:** the contract owner can change the fee (at most 10%), the vendor, the signer and the names adapter. The owner cannot move vaulted NFTs or payout pools.
- **Replay protection:** tickets and appraisals are EIP-712 signed under separate domains ("Kura BidGate" and "Kura CardVault"), bound to the chain and the verifying contract. Tickets are single use.

## License

Source files are MIT-licensed (see the SPDX headers).
