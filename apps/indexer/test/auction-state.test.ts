import { describe, expect, it } from "vitest";
import { balanceDeltas, checkpointRow, claimPatch, exitPatch, isSampleable, livePricePatch, requireActiveAuction } from "../src/lib/auction-state";
import { q96ToUsdcPerShard } from "../src/lib/math";

const ZERO = "0x0000000000000000000000000000000000000000";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b0";
const AUCTION = "0x0000000000000000000000000000000000000a11";
const VAULT = "0xEC598d41513A15Bb17D4FAeF5e127aB47A54f1B4";

describe("balanceDeltas", () => {
  it("credits the recipient of a mint and skips the zero address", () => {
    expect(balanceDeltas(ZERO, AUCTION, 60n)).toEqual([{ holder: AUCTION, delta: 60n }]);
  });
  it("debits the sender of a burn and skips the zero address", () => {
    expect(balanceDeltas(VAULT, ZERO, 5n)).toEqual([{ holder: VAULT, delta: -5n }]);
  });
  it("treats the auction and the vault like any other holder", () => {
    expect(balanceDeltas(AUCTION, ALICE, 7n)).toEqual([{ holder: AUCTION, delta: -7n }, { holder: ALICE, delta: 7n }]);
    expect(balanceDeltas(ALICE, VAULT, 3n)).toEqual([{ holder: ALICE, delta: -3n }, { holder: VAULT, delta: 3n }]);
  });
  it("moves shards between holders while the auction still holds its supply", () => {
    // Replay: mint 40 to Alice and 60 to the auction, Alice sends 10 to Bob, the auction pays a 25-shard claim to Bob.
    const balances = new Map<string, bigint>();
    const apply = (from: string, to: string, v: bigint) => {
      for (const d of balanceDeltas(from as `0x${string}`, to as `0x${string}`, v)) balances.set(d.holder, (balances.get(d.holder) ?? 0n) + d.delta);
    };
    apply(ZERO, ALICE, 40n);
    apply(ZERO, AUCTION, 60n);
    apply(ALICE, BOB, 10n);
    apply(AUCTION, BOB, 25n);
    expect(Object.fromEntries(balances)).toEqual({ [ALICE]: 30n, [AUCTION]: 35n, [BOB]: 35n });
  });
  it("nets a self-transfer to zero", () => {
    expect(balanceDeltas(ALICE, ALICE, 4n).reduce((s, d) => s + d.delta, 0n)).toBe(0n);
  });
});

describe("bid status", () => {
  it("marks an exited bid final even when nothing filled", () => {
    expect(exitPatch({ tokensFilled: 0n, currencyRefunded: 100n })).toEqual({ status: "exited", tokensFilled: 0n, currencyRefunded: 100n });
  });
  it("marks a claimed bid claimed", () => {
    expect(claimPatch()).toEqual({ status: "claimed" });
  });
});

describe("isSampleable", () => {
  it("samples only between the auction's start and end blocks", () => {
    expect(isSampleable(99n, 100n, 200n)).toBe(false);
    expect(isSampleable(100n, 100n, 200n)).toBe(true);
    expect(isSampleable(200n, 100n, 200n)).toBe(true);
    expect(isSampleable(201n, 100n, 200n)).toBe(false);
  });
});

describe("checkpointRow", () => {
  it("keys by auction and checkpoint block and widens cumulativeMps to bigint", () => {
    expect(checkpointRow(AUCTION, { blockNumber: 150n, clearingPriceQ96: 42n, cumulativeMps: 5_000_000 }, 1700000000)).toEqual({
      id: `${AUCTION}-150`,
      auction: AUCTION,
      blockNumber: 150n,
      clearingPriceQ96: 42n,
      cumulativeMps: 5_000_000n,
      timestamp: 1700000000,
    });
  });
});

describe("livePricePatch", () => {
  const price = 3n * 2n ** 96n;
  it("sets the live clearing price on an unsettled sharding", () => {
    expect(livePricePatch({ settled: false }, price)).toEqual({ clearingPriceQ96: price, clearingUsdcPerShard: q96ToUsdcPerShard(price) });
  });
  it("never touches a settled sharding, so a non-graduated null price stays null", () => {
    expect(livePricePatch({ settled: true }, price)).toBeNull();
  });
  it("skips when there is no sharding row", () => {
    expect(livePricePatch(undefined, price)).toBeNull();
  });
});

describe("requireActiveAuction", () => {
  it("returns the active row", () => {
    const row = { cardId: 1n, shardToken: "0x0000000000000000000000000000000000000011" as const };
    expect(requireActiveAuction(row, AUCTION, "BidSubmitted")).toBe(row);
  });
  it("throws a clear error for an unknown auction", () => {
    expect(() => requireActiveAuction(undefined, AUCTION, "BidSubmitted")).toThrow(/BidSubmitted.*no active_auctions row.*0x0000000000000000000000000000000000000a11/);
  });
});
