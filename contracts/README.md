# Kura contracts

Solidity contracts for Kura, a vault for physical Magic: The Gathering cards on Ethereum Sepolia.

- `CardVault` — ERC-721, one token per card in the vault. Owners shard a card into 16 to 512 shards and sell some
  through a Uniswap Continuous Clearing Auction. Anyone holding 80 percent of a card's shards can buy out the rest at
  the higher of the auction clearing price and a signed appraisal. The vendor earns a fee on sales and buyouts and
  records the physical handover.
- `ShardToken` — ERC-20 with 18 decimals, one per sharding, minted and burned only by the vault.
- `BidGateHook` — Uniswap CCA validation hook. Every bid carries a backend-signed World ID ticket; one human maps to one
  bidding wallet.
- `CardNames` — ENSv2 adapter. Every card gets `<card>-<set>-<id>.kura.eth`, non-transferable and revoked on release,
  with records for image, Scryfall id, condition, language and live vault state. The vendor may edit only condition and
  grade; the appraiser agent may edit only the appraisal keys. Collectors claim dash-free handles with their own
  permissioned resolver.

## Test

Fork tests run against Sepolia so the deployed Uniswap, Permit2, USDC and ENSv2 contracts are exercised.

    export SEPOLIA_RPC_URL=https://...
    forge test

`test/Scripts.fork.t.sol` runs the four deployment scripts below in order on a fork (warping past the commitment
age) and writes its JSON to the git-ignored `deployments/tmp/`.

## Deploy

1. Copy `.env.example` to `.env` and fill it in. The deployer must be a plain EOA (or one whose EIP-7702 delegate
   accepts ERC-1155): the `.eth` name and the `appraiser` subname are minted to it as ERC-1155 tokens.
   The deployer and the vendor both need Sepolia ETH for gas (the vendor sends the seed mint).
2. `forge script script/SetupEns.s.sol:SetupEnsCommit --rpc-url sepolia --broadcast`
3. Wait for the printed commitment age, then
   `forge script script/SetupEns.s.sol:SetupEnsRegister --rpc-url sepolia --broadcast`
4. `forge script script/Deploy.s.sol:Deploy --rpc-url sepolia --broadcast --verify`
5. `forge script script/Seed.s.sol:Seed --rpc-url sepolia --broadcast`

Addresses are written to `deployments/sepolia.json` and re-exported by `packages/shared`.

ENSv2 addresses default to `ensdomains/contracts-v2` at commit `48b3e2d` (`contracts/deployments/sepolia/*.json`) and
can be overridden with the `ENS_*` variables. The registrar is paid in that deployment's MockUSDC, which anyone can
mint; `SetupEnsCommit` mints the fee if the deployer holds too little.
The registrar also accepts Circle USDC: set `ENS_FEE_TOKEN=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` to pay with it
instead, in which case the deployer must already hold the fee (Circle USDC cannot be minted by the script).

`SetupEnsRegister` must run between the registrar's minimum commitment age (60 s) and its maximum (24 h) after
`SetupEnsCommit`. If the 24 h window lapses, rerun both phases with a new `VAULT_ENS_LABEL`: the registry and resolver
CREATE2 salts are derived from the label, so rerunning the commit with the same label would collide with the proxies
already deployed.

## Uniswap integration

- Auction creation: `CardVault.shardAndAuction` builds `AuctionParameters` and calls the CCA factory.
- Bid gating: `BidGateHook.validate` is the auction's validation hook.
- Settlement: `CardVault.settle` sweeps unsold tokens and currency as the auction's recipients.
- Bids fund through Permit2: approve USDC to Permit2, then allow the auction in Permit2, then `submitBid`.

## Operations

- **Rotating the signer** is two calls, not one: `BidGateHook.setSigner` (owner only) authorizes World ID tickets for
  bidding, and `CardVault.setSigner` (owner only) authorizes tickets and appraisals for release and redeem. Both must
  be rotated together, or the old signer stays valid on whichever contract was missed.
- **`CardVault.setNames` is not a recovery path.** A fresh `CardNames` has no labels for any existing card, so
  pointing the vault at one mid-flight leaves every already-minted card unresolvable through it. The emergency
  fallback for a broken `CardNames` is an adapter implementing `ICardNames` that no-ops on calls for cards it
  doesn't know about, rather than a replacement registrar that starts empty.
- **Never `transferFrom` a card to the vault address.** `CardVault.shardAndAuction` is the only path that should ever
  move a card's NFT to the vault, and it does so with `_transfer` from within the contract while recording
  `beneficialOwner`. A plain `transferFrom` to the vault address bypasses that bookkeeping, and the card becomes
  unrecoverable: there is no function that lets the vault return an NFT it holds without a matching `Sharding`
  record.
- **A non-graduated auction still records a clearing price.** `CardVault.settle` always reads `auction.clearingPrice()`
  and stores it, even when `isGraduated()` is false and no funds were swept. Treat that price as advisory only for a
  non-graduated sharding; it did not clear a real sale and should not be relied on for a redeem appraisal floor
  without checking `Sharding.graduated`.
- **`CardVault` is close to the EIP-170 24 KB size limit.** Before adding code to it, enable `via_ir` in
  `foundry.toml` or move the new logic into a library or a cloned satellite contract; a few more bytes of inline
  logic can push a deploy over the limit.
