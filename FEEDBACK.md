# Feedback for Uniswap: building on the Continuous Clearing Auction

Kura sells shards of vaulted trading cards through CCA v2.1.0 on Sepolia (factory `0x000000001F26a0044BaA66024e7b6599c61963F8`, source pinned at commit `7d7602d`). These notes come from building and testing that integration: the contracts, their Sepolia fork tests, the indexer and the web app.

## What we built with CCA

- **One auction per sharding.** `CardVault.shardAndAuction` deploys a fresh ERC-20 for the card's shards, calls the factory's `create`, mints the shards for sale straight into the auction and calls `onTokensReceived`. The vault is both `tokensRecipient` and `fundsRecipient`.
- **A two-step linear release.** `AuctionSteps.linear` spreads the supply evenly over the chosen duration (5 minutes to a month), with a last one-block step that absorbs the remainder.
- **Priced in Circle USDC.** The floor is on an exact tick, and prices convert between "USDC per whole shard" and the auction's Q96 "currency per token unit".
- **A validation hook** (`BidGateHook`) that requires a signed World ID ticket in `hookData` and binds one human to one bidding wallet.
- **A permissionless `settle`** on the vault. It sweeps the unsold shards back to the owner, and, when the auction graduated, sweeps the USDC, takes the vendor fee and pays the owner.
- **Bidder exits and claims in the web app.** Exits use `exitBid` or `exitPartiallyFilledBid`, with the hints computed from indexed `CheckpointUpdated` events.
- **An indexer** (Ponder) that follows every auction's bids, exits, claims, checkpoints and sweeps, and feeds the price history, demand curve and fill-rate charts.

## What worked well

- **The factory plus a validation hook was all we needed.** We gated every bid behind an off-chain identity check without forking the auction.
- **Fork testing against the real Sepolia deployment was smooth.** The factory, Permit2 and Circle USDC all worked in `forge test` with `vm.createSelectFork`, including full cycles of sell, buy out and sell again.
- **Checkpoint events give an exact price history.** `CheckpointUpdated(blockNumber, clearingPriceQ96, cumulativeMps)` let the indexer chart every clearing-price move without block-pinned archive reads, and it is exactly what the partial-exit hints need.
- **No protocol fee on Sepolia.** The factory's `protocolFeeController()` is `0x0` there, so `sweepCurrency` returns `currencyRaised` in full and our fee arithmetic stayed simple.

## What confused us

- **Hook reverts are wrapped.** Every revert from the validation hook arrives as `ValidationHookCallFailed(bytes reason)`. To tell an expired ticket (get a new one) from `AlreadyBound` (a new ticket won't help), the web decodes `reason` against the hook's ABI. Wallet SDKs don't surface decoded names, so we simulate each bid first and decode the error from the simulation.
- **A non-graduated auction still reports a clearing price.** After `settle` on an auction that missed its `requiredCurrencyRaised`, `clearingPrice()` is non-zero (at or above the floor). Every consumer, whether indexer, charts or buyout quote, has to check `isGraduated()` rather than treating a price as "it sold".
- **Outbid bids can't use `exitBid`.** In a graduated auction, `exitBid` reverts `CannotExitBid` for every bid with `maxPrice` at or below the final clearing price. That includes outbid bids with no fill, not only bids sitting exactly at the clearing price. Those bids need `exitPartiallyFilledBid(bidId, lastFullyFilledCheckpointBlock, outbidBlock)`. Without the right hints a bidder's USDC is effectively stuck in any oversubscribed auction.
- **Stale reads until the first post-end checkpoint.** `clearingPrice()`, `isGraduated()` and `currencyRaised()` are stored values that only a checkpoint updates, and the `END_BLOCK` checkpoint is written by the first call after the end. Before that, a read can be far off: in a fork run it showed 4.1 USDC raised before settle against 86.9 USDC at settle, and a clearing price of 10 against 32. The same thing bit a unit test, where `currencyRaised()` read 0 at the end block until we called `checkpoint()`. We gate exits and claims on our own `settle`, which triggers that checkpoint.
- **`TokensClaimed` is conditional.** `claimTokens` emits it only when `tokensFilled > 0`, so a zero-fill bid that has exited never looks "claimed" to an indexer. We treat "exited with nothing filled" as final.
- **No event carries the amount sold.** At settle the only sold-amount signal is `TokensSwept(tokensRecipient, unsold)`; sold is then the supply minus that. The other option is reading `totalCleared()` at the right moment.
- **Funding is Permit2-only.** An ERC-20 bid is pulled with `permit2TransferFrom`. A bidder therefore needs three transactions: approve the token to Permit2, `permit2.approve` the auction, then `submitBid`. A bid simulated before the Permit2 approval reverts with `TransferFromFailed`, which reads like a balance problem rather than a missing approval.
- **Only the recipient can sweep.** `sweepCurrency` and `sweepUnsoldTokens` revert `NotAuthorized` for anyone but the configured recipient. To keep settlement permissionless we made the vault the recipient of both and put the public `settle` on the vault.
- **The step bit layout is only in the source.** We confirmed the packed `bytes8` step format (high 24 bits MPS per block, low 40 bits block span) by reading `StepLib`. Because 1e7 MPS isn't divisible by most durations, an even schedule needs a second, one-block step for the remainder. A documented encoder, or a helper for "linear over N blocks", would have saved that.
- **The floor minimum comes from the factory.** A floor below `MIN_FLOOR_PRICE` surfaces as `FloorPriceTooLow` from inside `create`, so the error reaches our users from a contract they never called.
- **Rounding leaves dust.** A floor converted to Q96 rounds up, so fills come out a few wei of shards short, and about 2 wei of the token stays in the auction for good after every claim. It's harmless, but every exact-balance assertion needed a tolerance.
- **Installing the pinned commit took care.** `forge install` of the CCA repository recursed into its nested submodules (about 1.6 GB before we stopped it), so we added it with `git submodule add` and checked out the commit. The deployed v2.1.0 commit `7d7602d` isn't reachable from any branch tip, so a fresh clone has to fetch it by SHA.

## What was missing

- **A helper for exit hints.** Nothing on chain or in the repository's lenses (`AuctionStateLens`, `TickDataLens`) returns the `lastFullyFilledCheckpointBlock` and `outbidBlock` for a bid. Every integrator has to index checkpoints and rebuild that search.
- **A sold-amount field at settlement.** An event or view that states tokens sold and currency raised once the auction is final would spare each indexer from deriving it.
- **A tag for the deployed release.** A git tag, or a branch containing `7d7602d`, would make the pin reproducible in CI.

## Suggestions

1. Ship an exit-hint view or lens: `(bidId) → (lastFullyFilledCheckpointBlock, outbidBlock)`, or a single `exit(bidId)` that routes between the full and partial exits itself.
2. Document at the top of the integration guide that `clearingPrice()` is meaningful only together with `isGraduated()`, and that reads before the first post-end checkpoint are provisional.
3. Emit `TokensClaimed` with zero, or document that it is conditional, so indexers can close out every bid.
4. Add a documented step encoder, for example `linear(duration)`, next to `StepLib`, and document the bit layout.
5. Document `MIN_FLOOR_PRICE` and `MIN_TICK_SPACING` next to `create`, with an example in human units, since a floor that is too low only surfaces from inside the factory call.
6. Tag the deployed release commit.
