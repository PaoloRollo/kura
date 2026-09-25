import { describe, expect, it } from "vitest";
import { q96ToUsdcPerShard, usdcPerShardToQ96 } from "../src/lib/math";
import { redeemedCardPatch, settlementPatch, shardActivity, shardedCardPatch, transferPatch } from "../src/lib/vault-state";

const VAULT = "0xEC598d41513A15Bb17D4FAeF5e127aB47A54f1B4";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b0";

describe("transferPatch", () => {
  it("keeps the beneficial owner when the card moves into vault escrow", () => {
    const p = transferPatch({ beneficialOwner: ALICE, from: ALICE, to: VAULT.toLowerCase() as `0x${string}`, vault: VAULT });
    expect(p).toEqual({ ownerOf: VAULT.toLowerCase(), beneficialOwner: ALICE, isUserTransfer: false });
  });
  it("hands the beneficial owner to the recipient of a user transfer", () => {
    expect(transferPatch({ beneficialOwner: ALICE, from: ALICE, to: BOB, vault: VAULT })).toEqual({ ownerOf: BOB, beneficialOwner: BOB, isUserTransfer: true });
  });
  it("does not treat a release out of escrow as a user transfer", () => {
    expect(transferPatch({ beneficialOwner: ALICE, from: VAULT, to: BOB, vault: VAULT })).toEqual({ ownerOf: BOB, beneficialOwner: BOB, isUserTransfer: false });
  });
});

describe("transferPatch across card states", () => {
  it("follows the holder on a transfer after the card is released", () => {
    // Released is terminal on-chain, but the NFT stays transferable; the indexer keeps tracking the holder.
    expect(transferPatch({ beneficialOwner: ALICE, from: ALICE, to: BOB, vault: VAULT })).toMatchObject({ ownerOf: BOB, beneficialOwner: BOB });
  });
  it("keeps the old beneficial owner when a user sends a whole card straight to the vault", () => {
    expect(transferPatch({ beneficialOwner: ALICE, from: ALICE, to: VAULT, vault: VAULT })).toEqual({ ownerOf: VAULT, beneficialOwner: ALICE, isUserTransfer: false });
  });
});

describe("shardActivity", () => {
  it("records sale shards in 18-decimal units, credited to the card owner", () => {
    expect(shardActivity({ owner: ALICE, totalShards: 100, forSale: 60, auction: "0x0000000000000000000000000000000000000a11", shardToken: "0x0000000000000000000000000000000000000011" })).toEqual({
      actor: ALICE,
      amount: 60n * 10n ** 18n,
      meta: { totalShards: 100, forSale: 60, auction: "0x0000000000000000000000000000000000000a11", shardToken: "0x0000000000000000000000000000000000000011" },
    });
  });
});

describe("settlementPatch", () => {
  const price = usdcPerShardToQ96(2_500_000n);
  it("derives USDC per shard for a graduated auction", () => {
    expect(settlementPatch({ graduated: true, clearingPriceQ96: price, raisedUsdc: 10n, feeUsdc: 1n })).toEqual({
      settled: true, graduated: true, clearingPriceQ96: price, clearingUsdcPerShard: q96ToUsdcPerShard(price), raisedUsdc: 10n, feeUsdc: 1n,
    });
  });
  it("stores the raw price but no per-shard value when the auction did not graduate", () => {
    expect(settlementPatch({ graduated: false, clearingPriceQ96: price, raisedUsdc: 0n, feeUsdc: 0n })).toEqual({
      settled: true, graduated: false, clearingPriceQ96: price, clearingUsdcPerShard: null, raisedUsdc: 0n, feeUsdc: 0n,
    });
  });
});

describe("a card sharded twice", () => {
  it("points the card at the latest sharding while both shardings survive", () => {
    const shardings = new Map<string, { cardId: bigint }>();
    let card: Record<string, unknown> = { state: "whole", shardToken: null, auction: null, endBlock: null };
    const shard = (shardToken: `0x${string}`, auction: `0x${string}`, endBlock: bigint) => {
      shardings.set(shardToken, { cardId: 1n }); // keyed by shard token: a new sharding never overwrites an old one
      card = { ...card, ...shardedCardPatch({ shardToken, auction, endBlock }) };
    };
    shard("0x0000000000000000000000000000000000000011", "0x0000000000000000000000000000000000000a11", 100n);
    card = { ...card, state: "sharded" };
    card = { ...card, ...redeemedCardPatch(ALICE) };
    expect(card).toMatchObject({ state: "whole", beneficialOwner: ALICE, shardToken: null, auction: null, endBlock: null });
    shard("0x0000000000000000000000000000000000000022", "0x0000000000000000000000000000000000000a22", 200n);
    expect(card).toMatchObject({
      state: "auctioning",
      shardToken: "0x0000000000000000000000000000000000000022",
      auction: "0x0000000000000000000000000000000000000a22",
      endBlock: 200n,
    });
    expect([...shardings.keys()]).toEqual(["0x0000000000000000000000000000000000000011", "0x0000000000000000000000000000000000000022"]);
  });
});
