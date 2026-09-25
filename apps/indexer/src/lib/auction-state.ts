import { checkpointId } from "./ids";

type Hex = `0x${string}`;

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Balance changes for one ERC-20 Transfer. Every non-zero address is a holder, the auction contract and the vault
 * included: the auction holds the sale supply until claims drain it, and dashboards decide how to label it.
 */
export function balanceDeltas(from: Hex, to: Hex, value: bigint): { holder: Hex; delta: bigint }[] {
  const out: { holder: Hex; delta: bigint }[] = [];
  if (from.toLowerCase() !== ZERO) out.push({ holder: from, delta: -value });
  if (to.toLowerCase() !== ZERO) out.push({ holder: to, delta: value });
  return out;
}

/**
 * Bid columns on BidExited. "exited" is final for a bid that filled nothing: CCA emits TokensClaimed only when
 * tokensFilled > 0, so such a bid never reaches "claimed".
 */
export function exitPatch(p: { tokensFilled: bigint; currencyRefunded: bigint }) {
  return { status: "exited" as const, tokensFilled: p.tokensFilled, currencyRefunded: p.currencyRefunded };
}

/** Bid columns on TokensClaimed (only emitted after an exit with tokensFilled > 0). */
export function claimPatch() {
  return { status: "claimed" as const };
}

/** The price sampler reads an auction only while it runs: not before its start block, not after its end block. */
export function isSampleable(block: bigint, startBlock: bigint, endBlock: bigint): boolean {
  return block >= startBlock && block <= endBlock;
}

/** checkpoints row from Auction:CheckpointUpdated; keyed by the checkpoint's block, not the log's. */
export function checkpointRow(auction: Hex, a: { blockNumber: bigint; clearingPriceQ96: bigint; cumulativeMps: number }, timestamp: number) {
  return {
    id: checkpointId(auction, a.blockNumber),
    auction,
    blockNumber: a.blockNumber,
    clearingPriceQ96: a.clearingPriceQ96,
    cumulativeMps: BigInt(a.cumulativeMps),
    timestamp,
  };
}
