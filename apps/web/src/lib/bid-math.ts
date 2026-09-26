// Pure bid maths for the CCA auction panel: price ticks, the "if it ended now" preview, exit routing with checkpoint
// hints, and the human copy for auction reverts. No React, no chain reads, so it is unit-tested directly.
import { q96ToUsdcPerShard, usdcPerShardToQ96 } from "@kura/shared";

const SHARD = 10n ** 18n;

/** Shards (18 decimals) a USDC budget buys at `maxUsdcPerShard`. */
export function estimateShards(budgetUsdc: bigint, maxUsdcPerShard: bigint): bigint {
  if (maxUsdcPerShard === 0n) return 0n;
  return (budgetUsdc * SHARD) / maxUsdcPerShard;
}

/** The tick at or below `priceQ96`; 0 without a tick (no valid price). */
export const roundDownToTick = (priceQ96: bigint, tickQ96: bigint) => (tickQ96 > 0n ? (priceQ96 / tickQ96) * tickQ96 : 0n);

/** The default max: the clearing price rounded down to a tick, plus two ticks. */
export const defaultMaxPriceQ96 = (clearingQ96: bigint, tickQ96: bigint) => (tickQ96 > 0n ? roundDownToTick(clearingQ96, tickQ96) + 2n * tickQ96 : 0n);

/** A max the auction accepts: on a tick and at least one tick above clearing. */
export const isValidMax = (priceQ96: bigint, clearingQ96: bigint, tickQ96: bigint) => tickQ96 > 0n && priceQ96 % tickQ96 === 0n && priceQ96 >= clearingQ96 + tickQ96;

/**
 * The highest tick whose USDC price is at most `usdc`. Both Q96 conversions round (ceil one way, floor the other),
 * so `roundDownToTick(usdcPerShardToQ96(x))` alone can land one tick low when `x` is exactly on a tick.
 */
export function maxQ96FromUsdc(usdc: bigint, tickQ96: bigint): bigint {
  if (tickQ96 <= 0n || usdc <= 0n) return 0n;
  const k = usdcPerShardToQ96(usdc) / tickQ96;
  return q96ToUsdcPerShard((k + 1n) * tickQ96) <= usdc ? (k + 1n) * tickQ96 : k * tickQ96;
}

/** "If the auction ended now" (HisVE): what the bid would pay and get at the current clearing price. */
export function endedNowPreview(p: { budgetUsdc: bigint; maxQ96: bigint; clearingQ96: bigint; forSale: number }) {
  const clearingUsdc = q96ToUsdcPerShard(p.clearingQ96);
  const inTheMoney = p.maxQ96 > p.clearingQ96 && p.budgetUsdc > 0n;
  const cap = BigInt(p.forSale) * SHARD;
  const get = inTheMoney ? min(estimateShards(p.budgetUsdc, clearingUsdc), cap) : 0n;
  const spent = inTheMoney ? (get === cap ? (get * clearingUsdc) / SHARD : p.budgetUsdc) : 0n;
  return { clearingUsdc, shards: get, refundedUsdc: p.budgetUsdc - spent, outAtUsdc: q96ToUsdcPerShard(p.maxQ96) };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

// ---------------------------------------------------------------------------------------------------------------------
// Exits

export type ExitBid = { bidId: bigint; maxPriceQ96: bigint; submittedBlock: bigint };
export type ExitCheckpoint = { blockNumber: bigint; clearingPriceQ96: bigint };
export type ExitCall =
  | { fn: "exitBid"; args: readonly [bigint] }
  | { fn: "exitPartiallyFilledBid"; args: readonly [bigint, bigint, bigint] };

/**
 * How to exit a bid once the auction is over (the pinned CCA's `exitBid` / `exitPartiallyFilledBid`):
 * - not graduated, or graduated with max above the final clearing: `exitBid` (full refund / fully filled);
 * - graduated with max at or below the final clearing: `exitPartiallyFilledBid` with the last checkpoint that fully
 *   filled the bid (at or after its submission, clearing below its max) and the first checkpoint that outbid it
 *   (clearing above its max), or 0 when the bid sits exactly at the final clearing price.
 * `checkpoints` are the auction's, in any order. Null when the indexer has no fully filled checkpoint for the bid yet.
 */
export function exitRoute(bid: ExitBid, graduated: boolean, checkpoints: readonly ExitCheckpoint[], finalClearingQ96: bigint): ExitCall | null {
  if (!graduated || bid.maxPriceQ96 > finalClearingQ96) return { fn: "exitBid", args: [bid.bidId] };
  const sorted = [...checkpoints].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
  const lastFullyFilled = sorted.filter((c) => c.blockNumber >= bid.submittedBlock && c.clearingPriceQ96 < bid.maxPriceQ96).at(-1);
  if (!lastFullyFilled) return null;
  const outbid = sorted.find((c) => c.clearingPriceQ96 > bid.maxPriceQ96);
  return { fn: "exitPartiallyFilledBid", args: [bid.bidId, lastFullyFilled.blockNumber, outbid?.blockNumber ?? 0n] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Bid status (PA50F, oz3mH)

export type BidStatus = "open" | "exited" | "claimed";
export type BidView = {
  label: "open" | "at clearing · filling" | "outbid" | "filled" | "partially filled" | "refund due" | "refunded" | "claimed";
  tone: "good" | "kin" | "muted" | "shu";
  /** What the row can do next. */
  action: "none" | "exit-claim" | "claim" | "exit" | "take-back";
};

/**
 * The row state of one of my bids. `ended`: block >= endBlock. `graduated`: known once ended (null before).
 * A zero-fill exited bid is final: it stays "exited" forever (CCA emits TokensClaimed only for a fill), so it reads
 * "refunded" with nothing left to do.
 */
export function bidView(b: { status: BidStatus; maxPriceQ96: bigint; tokensFilled: bigint | null }, p: { ended: boolean; graduated: boolean | null; clearingQ96: bigint }): BidView {
  const filled = b.tokensFilled ?? 0n;
  if (b.status === "claimed") return { label: "claimed", tone: "muted", action: "none" };
  if (b.status === "exited") {
    if (filled === 0n) return { label: "refunded", tone: "muted", action: "none" };
    return p.graduated ? { label: "filled", tone: "good", action: "claim" } : { label: "filled", tone: "good", action: "none" };
  }
  if (!p.ended || p.graduated == null) {
    if (b.maxPriceQ96 > p.clearingQ96) return { label: "open", tone: "good", action: "none" };
    // At clearing the bid still fills pro rata with the other bids at that price.
    if (b.maxPriceQ96 === p.clearingQ96) return { label: "at clearing · filling", tone: "kin", action: "none" };
    return { label: "outbid", tone: "shu", action: "none" };
  }
  if (!p.graduated) return { label: "refund due", tone: "kin", action: "take-back" };
  if (b.maxPriceQ96 > p.clearingQ96) return { label: "filled", tone: "good", action: "exit-claim" };
  if (b.maxPriceQ96 === p.clearingQ96) return { label: "partially filled", tone: "good", action: "exit-claim" };
  return { label: "outbid", tone: "muted", action: "exit" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Auction stats (HisVE)

/** Demand over supply: Σ open bid budgets / (clearing × shards for sale), or null without a price. */
export function demandRatio(openBudgetsUsdc: bigint, clearingUsdcPerShard: bigint, forSale: number): number | null {
  const supply = clearingUsdcPerShard * BigInt(forSale);
  if (supply <= 0n) return null;
  return Number((openBudgetsUsdc * 1000n) / supply) / 1000;
}

// ---------------------------------------------------------------------------------------------------------------------
// Revert copy

/** BidGateHook errors that mean the cached World ID ticket is unusable: drop it and verify again. */
export const TICKET_ERRORS = new Set(["Expired", "BadSignature", "WrongKind", "WrongSubject"]);

/** Reverts a retry would only repeat: the input (or the wallet) has to change. */
const FINAL_BID_ERRORS = new Set([
  "AlreadyBound", "BidMustBeAboveClearingPrice", "InvalidBidPriceTooHigh", "BidAmountTooSmall", "AuctionIsOver",
  "AuctionNotStarted", "AuctionSoldOut", "InvalidBidUnableToClear", "TickPriceNotAtBoundary",
]);

export const isRetryableBidError = (name: string | null | undefined) => !name || !FINAL_BID_ERRORS.has(name);

/** The error card for a failed bid, by the decoded error (the hook's error inside ValidationHookCallFailed first). */
export function bidRevertMessage(name: string | null | undefined): { title: string; body?: string } | null {
  switch (name) {
    case "Expired":
      return { title: "Your World ID ticket expired", body: "Tickets last 24 hours. Your approvals are saved, so only the bid itself needs to be sent again." };
    case "BadSignature":
    case "WrongKind":
    case "WrongSubject":
      return { title: "Your World ID ticket isn't valid for this wallet", body: "Verify again to get a fresh ticket. Your approvals are saved, so only the bid itself needs to be sent again." };
    case "AlreadyBound":
      return { title: "This World ID already bids from another wallet", body: "One human, one bidding wallet. Log in with the wallet you bid from first." };
    case "BidMustBeAboveClearingPrice":
      return { title: "The price moved. Raise your max.", body: "The clearing price rose above your max. The form now suggests a new one." };
    case "InvalidBidPriceTooHigh":
      return { title: "That max price is above the auction's limit", body: "Lower your max price per shard." };
    case "BidAmountTooSmall":
      return { title: "That budget is too small", body: "Raise the amount you spend." };
    case "AuctionIsOver":
      return { title: "The auction has ended", body: "Bids are closed. Nothing was sent or charged." };
    case "AuctionNotStarted":
      return { title: "The auction hasn't started yet", body: "Try again in a few seconds." };
    case "AuctionSoldOut":
      return { title: "The auction is sold out", body: "Every shard is already spoken for. Nothing was sent or charged." };
    case "InvalidBidUnableToClear":
      return { title: "This bid could never fill", body: "At this max it can't clear before the auction ends. Raise your max." };
    case "TickPriceNotAtBoundary":
      return { title: "That price isn't on a price step", body: "Use a multiple of the auction's price step." };
    case "TokensNotReceived":
      return { title: "The auction isn't funded yet", body: "Its shards haven't arrived. Try again in a moment." };
    case "TransferFromFailed":
      return { title: "The auction couldn't pull your USDC", body: "Check your USDC balance, then retry: the approvals are checked again." };
    case "InsufficientAllowance":
    case "AllowanceExpired":
      return { title: "The auction can't pull your budget", body: "The USDC allowance ran out. Retry to approve it again." };
    default:
      return null;
  }
}

/** The error card for a failed exit or claim. */
export function exitRevertMessage(name: string | null | undefined): { title: string; body?: string } | null {
  switch (name) {
    case "InvalidLastFullyFilledCheckpointHint":
    case "InvalidOutbidBlockCheckpointHint":
      return { title: "The indexer is still catching up", body: "Try again in a few seconds." };
    case "AuctionIsNotOver":
    case "NotClaimable":
    case "CannotPartiallyExitBidBeforeEndBlock":
      return { title: "The auction hasn't ended yet", body: "Exits open at the end block." };
    case "BidAlreadyExited":
      return { title: "This bid was already exited", body: "The page refreshes once the indexer catches up." };
    case "BidNotExited":
      return { title: "Exit the bid first", body: "Claiming needs the bid to be exited." };
    case "NotGraduated":
      return { title: "The auction didn't graduate", body: "There are no shards to claim; take back your budget instead." };
    case "CannotExitBid":
      return { title: "This bid can't be exited that way yet", body: "Try again in a few seconds." };
    default:
      return null;
  }
}
