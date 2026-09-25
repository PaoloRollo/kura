import { q96ToUsdcPerShard } from "./math";

type Hex = `0x${string}`;

/**
 * ERC-721 transfer: `ownerOf` always follows the token. A move into vault escrow keeps the beneficial owner;
 * any other move hands it to the recipient. Only transfers that touch neither side of escrow are user transfers.
 */
export function transferPatch(p: { beneficialOwner: Hex; from: Hex; to: Hex; vault: string }) {
  const vault = p.vault.toLowerCase();
  const toVault = p.to.toLowerCase() === vault;
  const fromVault = p.from.toLowerCase() === vault;
  return {
    ownerOf: p.to,
    beneficialOwner: toVault ? p.beneficialOwner : p.to,
    isUserTransfer: !toVault && !fromVault,
  };
}

/** Card columns on CardSharded: the card always points at its latest sharding. */
export function shardedCardPatch(p: { shardToken: Hex; auction: Hex; endBlock: bigint }) {
  return { state: "auctioning" as const, shardToken: p.shardToken, auction: p.auction, endBlock: p.endBlock };
}

/** Card columns on CardRedeemed: back to whole under the redeemer, detached from the sharding (as the contract does). */
export function redeemedCardPatch(redeemer: Hex) {
  return { state: "whole" as const, beneficialOwner: redeemer, shardToken: null, auction: null, endBlock: null };
}

/**
 * Sharding columns on AuctionSettled. The raw clearing price is always stored; the derived USDC-per-shard value
 * is null for an auction that did not graduate, since no shards sold at that price.
 */
export function settlementPatch(p: { graduated: boolean; clearingPriceQ96: bigint; raisedUsdc: bigint; feeUsdc: bigint }) {
  return {
    settled: true,
    graduated: p.graduated,
    clearingPriceQ96: p.clearingPriceQ96,
    clearingUsdcPerShard: p.graduated ? q96ToUsdcPerShard(p.clearingPriceQ96) : null,
    raisedUsdc: p.raisedUsdc,
    feeUsdc: p.feeUsdc,
  };
}
