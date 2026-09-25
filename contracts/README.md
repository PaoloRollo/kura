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
2. `forge script script/SetupEns.s.sol:SetupEnsCommit --rpc-url sepolia --broadcast`
3. Wait for the printed commitment age, then
   `forge script script/SetupEns.s.sol:SetupEnsRegister --rpc-url sepolia --broadcast`
4. `forge script script/Deploy.s.sol:Deploy --rpc-url sepolia --broadcast --verify`
5. `forge script script/Seed.s.sol:Seed --rpc-url sepolia --broadcast`

Addresses are written to `deployments/sepolia.json` and re-exported by `packages/shared`.

ENSv2 addresses default to `ensdomains/contracts-v2` at commit `48b3e2d` (`contracts/deployments/sepolia/*.json`) and
can be overridden with the `ENS_*` variables. The registrar is paid in that deployment's MockUSDC, which anyone can
mint; `SetupEnsCommit` mints the fee if the deployer holds too little.

## Uniswap integration

- Auction creation: `CardVault.shardAndAuction` builds `AuctionParameters` and calls the CCA factory.
- Bid gating: `BidGateHook.validate` is the auction's validation hook.
- Settlement: `CardVault.settle` sweeps unsold tokens and currency as the auction's recipients.
- Bids fund through Permit2: approve USDC to Permit2, then allow the auction in Permit2, then `submitBid`.
