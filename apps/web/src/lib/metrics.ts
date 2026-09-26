// Card and market analytics, pure: the Card analytics tab (LqnA2) and the Analytics dashboard (Y1eNn, WABQw) read these.
// Market prices always come from lib/pricing (quoteUsdc), never the raw Scryfall price.
import { q96ToUsdcPerShard } from "@kura/shared";
import { canRedeem, clearingPerShard, shareOf } from "@/lib/card-view";

const SHARD = 10n ** 18n;
const lc = (a: string) => a.toLowerCase();

type ShardingRef = { graduated: boolean | null; clearingPriceQ96: bigint | null; totalShards: number };

/**
 * Implied card value: the reference price per shard × total shards. Settled (`graduated !== null`): the clearing price,
 * n/a when the auction did not graduate. Auctioning: the latest checkpoint's clearing price (the caller labels it
 * "live"). Once the card's Uniswap pool trades (`poolUsdcPerShard`, see lib/market `poolValuePrice`), its price. Null
 * without a reference.
 */
export function impliedValueUsdc(sharding: ShardingRef | null, liveClearingQ96?: bigint | null, poolUsdcPerShard?: bigint | null): bigint | null {
  if (!sharding) return null;
  const ref = poolUsdcPerShard != null && poolUsdcPerShard > 0n ? poolUsdcPerShard
    : sharding.graduated !== null ? clearingPerShard(sharding) : liveClearingQ96 != null ? q96ToUsdcPerShard(liveClearingQ96) : null;
  if (ref == null || ref === 0n) return null;
  return ref * BigInt(sharding.totalShards);
}

/** Implied value vs market (USDC, from quoteUsdc) as a fraction: +0.25 = 25% above. Null without both. */
export function premium(impliedUsdc: bigint | null, marketUsdc: bigint | null): number | null {
  if (impliedUsdc == null || marketUsdc == null || marketUsdc === 0n) return null;
  return Number((impliedUsdc * 1_000_000n) / marketUsdc) / 1_000_000 - 1;
}

type Holder = { holder: string; balance: bigint };

/** Shares of the non-custodian live supply (custodians = card-view `custodians()`), largest first. */
export function shares(holders: readonly Holder[], exclude: Iterable<string>): { holder: string; balance: bigint; share: number }[] {
  const ex = new Set([...exclude].map(lc));
  const live = holders.filter((h) => h.balance > 0n && !ex.has(lc(h.holder)));
  const supply = live.reduce((a, h) => a + h.balance, 0n);
  if (supply === 0n) return [];
  return live
    .map((h) => ({ holder: h.holder, balance: h.balance, share: shareOf(h.balance, supply) }))
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
}

/** Herfindahl–Hirschman index, Σ share²: 1.0 = one owner. */
export const hhi = (s: readonly { share: number }[]) => s.reduce((a, x) => a + x.share * x.share, 0);

/**
 * Distance of the top non-custodian holder to the 80% redemption rule, on the FULL supply (ShardToken.totalSupply(),
 * auction and vault included, as the contract checks it). `shardsShort` is in 18-decimal units.
 */
export function distanceToRedemption(topBalance: bigint, fullSupply: bigint): { fraction: number; shardsShort: bigint; eligible: boolean } {
  if (fullSupply <= 0n) return { fraction: 0.8, shardsShort: 0n, eligible: false };
  const eligible = canRedeem(topBalance, fullSupply);
  const needed = (fullSupply * 4n + 4n) / 5n; // ceil(0.8 × supply) in wei
  return {
    fraction: Math.max(0, 0.8 - shareOf(topBalance, fullSupply)),
    shardsShort: eligible ? 0n : needed - topBalance,
    eligible,
  };
}

type SoldSharding = { auction: string; forSale: number; settled: boolean; graduated: boolean | null };
type SweepTransfer = { from: string; to: string; amount: bigint };

/**
 * Shards sold by the sharding's auction (18-decimal units). Settled: forSale minus the unsold sweep (settle's
 * sweepUnsoldTokens sends them auction → vault; bidder claims go auction → bidder). Not graduated: 0 (the sweep
 * returns every shard). Auctioning: the latest tick's totalCleared ("live"), or null without one.
 */
export function tokensSold(sharding: SoldSharding, transfers: readonly SweepTransfer[], vault: string, latestTick?: { totalCleared: bigint } | null): bigint | null {
  if (!sharding.settled) return latestTick?.totalCleared ?? null;
  if (sharding.graduated === false) return 0n;
  const auction = lc(sharding.auction), v = lc(vault);
  const swept = transfers.filter((t) => lc(t.from) === auction && lc(t.to) === v).reduce((a, t) => a + t.amount, 0n);
  const sold = BigInt(sharding.forSale) * SHARD - swept;
  return sold > 0n ? sold : 0n;
}

/** Sold / for sale, 0..1; null when the sold amount is unknown. */
export function fillRate(sold: bigint | null, forSale: number): number | null {
  if (sold == null) return null;
  if (forSale <= 0) return 0;
  return Number((sold * 10_000n) / (BigInt(forSale) * SHARD)) / 10_000;
}

/** Distinct bidders. BidGateHook binds one World ID nullifier to one wallet, so this counts unique humans. */
export const participation = (bids: readonly { owner: string }[]) => new Set(bids.map((b) => lc(b.owner))).size;

export const vendorEarnings = (fees: readonly { amountUsdc: bigint }[]) => fees.reduce((a, f) => a + f.amountUsdc, 0n);

/** Fees to the vault, split by kind (`feeEvents.kind`). */
export function feesByKind(fees: readonly { kind: "sale" | "buyout"; amountUsdc: bigint }[]): { sale: bigint; buyout: bigint; total: bigint } {
  let sale = 0n, buyout = 0n;
  for (const f of fees) {
    if (f.kind === "sale") sale += f.amountUsdc;
    else buyout += f.amountUsdc;
  }
  return { sale, buyout, total: sale + buyout };
}
