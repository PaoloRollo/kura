import { describe, expect, it } from "vitest";
import {
  age,
  awaitingHandover,
  describeMintError,
  feeTotals,
  feesCsv,
  feesPerDay,
  holderCounts,
  inTab,
  matchesSearch,
  stationStats,
  tabCounts,
} from "@/lib/vendor";

const VAULT = "0x00000000000000000000000000000000000000aa";
const card = (id: number, state: "whole" | "auctioning" | "sharded" | "released", extra: Partial<Record<string, unknown>> = {}) => ({
  id: BigInt(id),
  state,
  ownerOf: "0x0000000000000000000000000000000000000001" as `0x${string}`,
  beneficialOwner: "0x0000000000000000000000000000000000000002" as `0x${string}`,
  ensName: `card-${id}.kura.eth`,
  shardToken: null as `0x${string}` | null,
  auction: null as `0x${string}` | null,
  mintedAt: 0,
  ...extra,
});

describe("inventory", () => {
  it("puts auctioning and sharded cards in the Sharded tab and counts each tab", () => {
    const cards = [card(1, "whole"), card(2, "auctioning"), card(3, "sharded"), card(4, "released")];
    expect(cards.filter((c) => inTab(c.state, "sharded")).map((c) => c.id)).toEqual([2n, 3n]);
    expect(tabCounts(cards)).toEqual({ all: 4, whole: 1, sharded: 2, released: 1 });
  });

  it("counts shard holders with a positive balance, excluding the auction and the vault", () => {
    const token = "0x00000000000000000000000000000000000000Cc" as `0x${string}`;
    const auction = "0x00000000000000000000000000000000000000Dd" as `0x${string}`;
    const cards = [card(1, "sharded", { shardToken: token, auction })];
    const balances = [
      { shardToken: token.toLowerCase(), holder: "0x01", balance: 5n },
      { shardToken: token.toLowerCase(), holder: "0x02", balance: 0n },
      { shardToken: token.toLowerCase(), holder: auction.toLowerCase(), balance: 9n },
      { shardToken: token.toLowerCase(), holder: VAULT, balance: 3n },
      { shardToken: token.toLowerCase(), holder: "0x03", balance: 1n },
    ];
    expect(holderCounts(cards, balances, VAULT).get(1n)).toBe(2);
  });

  it("marks whole cards whose latest sharding has a redeemer as awaiting handover", () => {
    const cards = [card(1, "whole"), card(2, "whole"), card(3, "sharded")];
    const shardings = [
      { cardId: 1n, createdAt: 10, redeemer: "0x09" },
      { cardId: 1n, createdAt: 20, redeemer: null },
      { cardId: 2n, createdAt: 10, redeemer: null },
      { cardId: 2n, createdAt: 30, redeemer: "0x08" },
      { cardId: 3n, createdAt: 40, redeemer: "0x07" },
    ];
    expect([...awaitingHandover(cards, shardings)]).toEqual([2n]);
  });

  it("searches by card name, ENS name or owner", () => {
    const row = { name: "Black Lotus", ensName: "black-lotus-lea-1.kura.eth", owner: "0xDeADaD159DF0923dAF871f8B4740eD7f7F417ee9" };
    expect(matchesSearch(row, "")).toBe(true);
    expect(matchesSearch(row, "lotus")).toBe(true);
    expect(matchesSearch(row, "LEA-1")).toBe(true);
    expect(matchesSearch(row, "0xdead")).toBe(true);
    expect(matchesSearch(row, "mox")).toBe(false);
  });
});

describe("fees", () => {
  const now = Date.UTC(2026, 8, 26, 12) / 1000;
  const day = 86_400;
  const fees = [
    { id: "a", cardId: 1n, kind: "sale" as const, amountUsdc: 1_000_000n, timestamp: now - 3600 },
    { id: "b", cardId: 1n, kind: "buyout" as const, amountUsdc: 2_500_000n, timestamp: now - 2 * day },
    { id: "c", cardId: 2n, kind: "sale" as const, amountUsdc: 500_000n, timestamp: now - 10 * day },
  ];

  it("totals all fees and the last seven days", () => {
    expect(feeTotals(fees, now)).toEqual({ total: 4_000_000n, week: 3_500_000n });
  });

  it("groups fees per UTC day, oldest first, with empty days", () => {
    const days = feesPerDay(fees, 7, now);
    expect(days).toHaveLength(7);
    expect(days[6]).toEqual({ day: "2026-09-26", sale: 1_000_000n, buyout: 0n });
    expect(days[4]).toEqual({ day: "2026-09-24", sale: 0n, buyout: 2_500_000n });
    expect(days[0].day).toBe("2026-09-20");
  });

  it("exports the ledger as CSV", () => {
    const csv = feesCsv([{ ...fees[0], name: 'Black "Lotus"' }]);
    expect(csv.split("\n")[0]).toBe("time,kind,card_id,card,amount_usdc,event_id");
    expect(csv.split("\n")[1]).toBe(`${new Date((now - 3600) * 1000).toISOString()},sale,1,"Black ""Lotus""",1.00,a`);
  });

  it("formats ages like the ledger", () => {
    expect(age(now - 30, now)).toBe("now");
    expect(age(now - 22 * 60, now)).toBe("22m");
    expect(age(now - 2 * 3600, now)).toBe("2h");
    expect(age(now - 3 * day, now)).toBe("3d");
  });
});

describe("station stats", () => {
  it("counts today's mints and fees and the cards in custody", () => {
    const midnight = new Date(2026, 8, 26).getTime() / 1000;
    const cards = [card(1, "whole", { mintedAt: midnight + 60 }), card(2, "released", { mintedAt: midnight - 60 }), card(3, "sharded", { mintedAt: midnight - 60 })];
    const fees = [{ amountUsdc: 3n, timestamp: midnight + 5 }, { amountUsdc: 4n, timestamp: midnight - 5 }];
    expect(stationStats(cards, fees, midnight + 3600)).toEqual({ mintedToday: 1, inCustody: 2, feesToday: 3n });
  });
});

describe("mint errors", () => {
  const revert = (name: string | null, extra: object = {}) => ({ name, args: [], message: "reverted", ...extra });
  it("explains the vault's mint reverts", () => {
    for (const name of ["OnlyVendor", "InvalidLabel", "InvalidCondition", "InvalidLanguage"]) {
      const d = describeMintError(null, revert(name));
      expect(d.title).toBe("The vault refused this mint");
      expect(d.body).toMatch(/Nothing was minted\.$/);
    }
    expect(describeMintError(null, revert("OnlyVendor")).body).toContain("vendor wallet");
  });
  it("falls back for mined reverts, cancellations and other errors", () => {
    expect(describeMintError(null, revert(null, { hash: "0x1" })).title).toBe("The mint reverted");
    expect(describeMintError(null, revert(null, { message: "User rejected the request" })).title).toBe("Request cancelled");
    expect(describeMintError(null, revert(null, { message: "boom" }))).toEqual({ title: "Couldn't send the mint", body: "boom" });
  });
});
