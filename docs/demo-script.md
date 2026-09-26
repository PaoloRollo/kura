# Kura demo script (about five minutes)

Everything runs on Ethereum Sepolia at **https://kuravault.xyz**.

## Devices and wallets

| Device | Who | Signed in as | Opens |
|---|---|---|---|
| Vendor laptop, on the big screen | the vendor | the vendor EOA `0x7aD5…F9fe`, "wallet" login | `https://kuravault.xyz/vendor/scan`, later `/vendor/vault` |
| Phone 1 | the card owner | the presenter's Kura account, with its collector handle and the Profile QR ready | `https://kuravault.xyz/app` |
| Phone 2 | the bidder (a judge) | a second Kura account, **World App installed** and verified | the auction link from phone 1 |

The seeded collectors from `pnpm rehearse --broadcast` fill the vault's history and serve as fallbacks: owners `seedaiko.kura.eth` and `seedkenji.kura.eth`, bidders `seedmei`, `seedren`, `seedsora` and `seedyuki.kura.eth`. Their addresses and card ids are in `scripts/seed/sepolia.json`.

**Fallback card ids** (`scripts/seed/sepolia.json` → `cards`):

| State | Card | Id |
|---|---|---|
| Live auction with one pre-seeded bid | A, Lightning Bolt, re-sharded after its buyout | #3 `lightning-bolt-4ed-3` |
| Sharded after a graduated auction | B, Counterspell | #4 `counterspell-a25-4` |
| Reserve not met, bids refunded | C, Llanowar Elves | #5 `llanowar-elves-btd-5` |
| Released at the counter | D, Dark Ritual | #6 `dark-ritual-sum-6` |
| Whole, owned by `seedaiko` | E, Swords to Plowshares | #7 `swords-to-plowshares-mb2-7` |

## Before you start

- Run `pnpm rehearse` (the plan, a budget check) and `pnpm rehearse --dry-run` on the laptop. Both must end without errors.
- Open `https://kuravault.xyz/app/analytics` once, so the indexer and the price routes are warm.
- Phone 1 holds a little Sepolia USDC for the buyout, and phone 2 about 1 USDC for a bid (https://faucet.circle.com).
- Have the physical card at the counter, with a Scryfall price between $0.25 and $3 so every amount stays small.

## 1. Mint at the station (vendor laptop)

1. Open on `https://kuravault.xyz`. **Screen: `VOzoC` Landing.** One line: a vault for real cards, split into shards, bought back whole.
2. Open `https://kuravault.xyz/vendor/scan`. **Screen: `iRZ36` Scanning station.**
3. Hold the card to the webcam, pick the match, and set the condition and language.
4. Scan the owner's collector QR from phone 1 (Profile), or type their Kura handle.
5. Mint. **Screen: `anR2F` Mint success.** Point at the card's ENS name, `<slug>-<set>-<id>.kura.eth`.

Say: the physical card stays in the vendor's vault; its twin is an ERC-721 with a non-transferable ENS name.

## 2. Shard and auction (phone 1)

1. On `https://kuravault.xyz/app`, the new card is in the portfolio. Open it at `/app/cards/<id>`. **Screen: `HisVE` Card page.**
2. Tap Shard: 16 shards, sell 3, floor prefilled from Scryfall, **5 minutes** (25 blocks). Confirm the single transaction.
3. The card page switches to the live auction. Put `/app/cards/<id>?tab=auction` on the big screen.

## 3. Bid with World ID (phone 2)

1. Open the auction link. Tap Place a bid, then Verify with World ID; World App completes the Proof of Human. **Screen: `aD9is` Bid with World ID.**
2. Approve and bid (USDC → Permit2, Permit2 → auction, bid). The bid lands; the big screen shows the toast and the chart ticks.
3. Refusal: sign in on phone 2 with another Kura account and verify with the same World ID. The refusal sheet explains that this World ID is already linked to another wallet. **Screen: `p5hrR` Bid · World ID refused.**

**If the World ID step fails (30 seconds):** say "World's staging verifier is down, so here is the same auction with a bid placed earlier". Open the fallback **live auction, card A** (#3, Lightning Bolt), at `https://kuravault.xyz/app/cards/3?tab=auction`. `seedyuki.kura.eth` has a bid on it, placed through the same `BidGateHook` with a signed HUMAN ticket. Show the bid in the order book and the Activity tab, then go on with step 4 on card A's history.

## 4. Settle, exit and claim

1. When the auction ends, tap Settle on phone 1. **Screen: `Oh2m9` Owner · Auction settled**: shards sold, USDC raised, the vendor fee.
2. On phone 2, Exit bid and claim the shards. The holders bar redraws with the handles.
3. On the laptop, `/vendor/fees` shows the vendor's earnings.

Fallback: card B (graduated, still sharded) shows the same settled state with four bidders.

## 5. Buy out (phone 1)

1. Phone 1 holds 13 of 16 shards (81%). Open `/app/cards/<id>/redeem`. **Screen: `M3M7L5` Redeem**: the price per shard is the higher of the clearing price and the appraisal signed by `appraiser.kura.eth`; that appraisal is also published on the card's ENS name as `appraisal.usd`.
2. Approve and redeem. The card is whole again under phone 1.
3. On phone 2, open the card and claim the payout. **Screen: `UwCiy` Payout claimed.**

Fallback: card A was bought out in the rehearsal; its Activity tab shows the buyout and three minority payouts.

## 6. Release at the counter

1. On phone 1, on the whole card, tap **Collect at the counter** and verify with World ID Passport. Phone 1 shows a four-character match code.
2. On the laptop, open `https://kuravault.xyz/vendor/vault?tab=whole` and select the card. The station shows "Passport verified" with the same code. Confirm the handover. **Screen: `ykB2t` Handover confirmed.**
3. The card shows the Released badge, and its ENS name is gone from the registry.

Fallback: card D was released this way in the rehearsal.

## Close

Open `https://kuravault.xyz/app/analytics`. **Screen: `Y1eNn` Analytics**: value locked, the market map, daily volume and the richest premiums. Then open one card's analytics tab, `/app/cards/<id>?tab=analytics`. **Screen: `LqnA2` Card analytics**: price per shard against the market, the demand curve, holders over time and the distance to redemption.
