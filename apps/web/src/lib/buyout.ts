import { q96ToUsdcPerShard } from "@kura/shared";
import { canRedeem } from "@/lib/card-view";

// The buyout arithmetic of CardVault.redeem / claimPayout, mirrored for quotes. Pure, so the panel and tests share it.

const SHARD = 10n ** 18n;

export { canRedeem };

/** Shard units still needed to reach 80% (0 once eligible): ceil(supply * 4 / 5) - balance. */
export function shardsShort(balance: bigint, supply: bigint): bigint {
  const need = (supply * 4n + 4n) / 5n;
  return need > balance ? need - balance : 0n;
}

/** PriceMath.payoutFor: floor(usdcPerShard * units / 1e18). */
export const payoutFor = (usdcPerShard: bigint, units: bigint): bigint => (usdcPerShard * units) / SHARD;

export type BuyoutQuote = {
  eligible: boolean;
  /** The redeemer holds every shard: nothing to pay, no appraisal needed. */
  full: boolean;
  /** Shard units the redeemer does not hold (supply - balance). */
  missing: bigint;
  clearing: bigint;
  appraised: bigint;
  /** max(clearing, appraisal): the buyout price per whole shard. */
  price: bigint;
  payout: bigint;
  fee: bigint;
  /** payout + fee: what the redeemer approves and pays. */
  total: bigint;
};

/**
 * What `redeem` charges, computed from what the contract reads at tx time: `totalSupply()`, `balanceOf(me)`,
 * the sharding's clearingPriceQ96 (set at settle, graduated or not) and `feeBps()`.
 */
export function buyoutQuote(p: { supply: bigint; balance: bigint; clearingQ96: bigint; appraisedUsdcPerShard: bigint; feeBps: bigint }): BuyoutQuote {
  const eligible = canRedeem(p.balance, p.supply);
  const full = p.supply > 0n && p.balance >= p.supply;
  const missing = p.supply > p.balance ? p.supply - p.balance : 0n;
  const clearing = q96ToUsdcPerShard(p.clearingQ96);
  const appraised = full ? 0n : p.appraisedUsdcPerShard;
  const price = appraised > clearing ? appraised : clearing;
  const payout = full ? 0n : payoutFor(price, missing);
  const fee = (payout * p.feeBps) / 10_000n;
  return { eligible, full, missing, clearing, appraised, price, payout, fee, total: payout + fee };
}

/** "After sending you'll hold 12.0 (75%)": shown when a transfer takes the sender from eligible to below 80%. */
export function dropsBelowThreshold(balance: bigint, supply: bigint, amount: bigint): boolean {
  return canRedeem(balance, supply) && !canRedeem(balance - (amount > balance ? balance : amount), supply);
}
