import { describe, expect, it } from "vitest";
import { encodeAbiParameters, getAddress, encodeEventTopics, keccak256, toHex, type Hex, type Log } from "viem";
import { abi } from "@kura/shared";
import { addresses } from "@/lib/chain";
import {
  age,
  awaitingHandover,
  describeMintError,
  mintedFromLogs,
  shardedFromLogs,
  mintOutcome,
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

  it("escapes CSV cells and blocks formula injection", () => {
    const row = (name: string) => feesCsv([{ ...fees[0], name }]).split("\n").slice(1).join("\n").split(",")[3];
    expect(row("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(row("+1")).toBe("'+1");
    expect(row("-1")).toBe("'-1");
    expect(row("@SUM")).toBe("'@SUM");
    expect(row("a\rb")).toBe('"a\rb"');
    expect(row("Plain")).toBe("Plain");
  });

  it("formats ages like the ledger", () => {
    expect(age(now - 30, now)).toBe("now");
    expect(age(now - 22 * 60, now)).toBe("22m");
    expect(age(now - 2 * 3600, now)).toBe("2h");
    expect(age(now - 3 * day, now)).toBe("3d");
  });
});

describe("station stats", () => {
  it("counts today's mints and fees (UTC day) and the cards in custody", () => {
    const midnight = Date.UTC(2026, 8, 26) / 1000;
    const cards = [card(1, "whole", { mintedAt: midnight + 60 }), card(2, "released", { mintedAt: midnight - 60 }), card(3, "sharded", { mintedAt: midnight - 60 })];
    const fees = [{ amountUsdc: 3n, timestamp: midnight + 5 }, { amountUsdc: 4n, timestamp: midnight - 5 }];
    expect(stationStats(cards, fees, midnight + 3600)).toEqual({ mintedToday: 1, inCustody: 2, feesToday: 3n });
    // Just before UTC midnight, the day before still counts, whatever the local time zone.
    expect(stationStats(cards.slice(1), [fees[1]], midnight - 1)).toEqual({ mintedToday: 2, inCustody: 1, feesToday: 4n });
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

describe("mintedFromLogs", () => {
  const owner = "0x4f2ca0b3ae1f3d7a0b6d2f0c1e4b5a6d7c8ea81e" as const;
  const node = keccak256(toHex("mox-sapphire-lea-2.kura.eth"));
  const log = (address: Hex, topics: Hex[], data: Hex, logIndex: number) =>
    ({ address, topics, data, logIndex, blockNumber: 1n, blockHash: "0x01", transactionHash: "0x02", transactionIndex: 0, removed: false }) as unknown as Log;
  const cardMinted = (address: Hex, id: bigint, label: string, i: number) =>
    log(
      address,
      encodeEventTopics({ abi: abi.cardVault, eventName: "CardMinted", args: { id, to: owner } }) as Hex[],
      encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }], ["sf-id", label, "NM", "en"]),
      i,
    );
  const ensLogs = [
    log(
      addresses.ensRegistry,
      encodeEventTopics({ abi: abi.ensRegistry, eventName: "LabelRegistered", args: { tokenId: 7n, labelHash: keccak256(toHex("mox-sapphire-lea-2")), sender: addresses.cardNames } }) as Hex[],
      encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "uint64" }], ["mox-sapphire-lea-2", addresses.cardNames, 0n]),
      0,
    ),
    // ENSv2 PermissionedResolver: the record is created (Linked) and then written by record id.
    log(
      addresses.ensResolver,
      encodeEventTopics({ abi: abi.ensResolver, eventName: "Linked", args: { recordId: 1n, node } }) as Hex[],
      encodeAbiParameters([{ type: "bytes" }], ["0x12"]),
      1,
    ),
    log(
      addresses.ensResolver,
      encodeEventTopics({ abi: abi.ensResolver, eventName: "TextUpdated", args: { recordId: 1n, keyHash: "condition" } }) as Hex[],
      encodeAbiParameters([{ type: "string" }, { type: "string" }], ["condition", "NM"]),
      2,
    ),
    log(
      addresses.ensResolver,
      encodeEventTopics({ abi: abi.ensResolver, eventName: "AddressUpdated", args: { recordId: 1n } }) as Hex[],
      encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [60n, owner]),
      3,
    ),
  ];

  it("reads CardMinted from the vault's log among the ENS logs", () => {
    const logs = [...ensLogs, cardMinted(addresses.cardVault, 2n, "mox-sapphire-lea-2", 4)];
    expect(mintedFromLogs(logs)).toEqual({ id: 2n, label: "mox-sapphire-lea-2", to: getAddress(owner) });
  });

  it("ignores a CardMinted emitted by any other contract", () => {
    const spoof = cardMinted("0x000000000000000000000000000000000000beef", 99n, "fake-lea-99", 0);
    expect(mintedFromLogs([spoof, ...ensLogs])).toBeNull();
    expect(mintedFromLogs([spoof, cardMinted(addresses.cardVault.toLowerCase() as Hex, 3n, "real-lea-3", 4)])?.id).toBe(3n);
  });

  it("returns null when there is no CardMinted", () => {
    expect(mintedFromLogs(ensLogs)).toBeNull();
    expect(mintedFromLogs([])).toBeNull();
  });
});

describe("shardedFromLogs", () => {
  const owner = "0x4f2ca0b3ae1f3d7a0b6d2f0c1e4b5a6d7c8ea81e" as const;
  const token = "0x8c0b76235b3c4d179c0576517ae1c66640c8cebf" as const;
  const auction = "0xdb6e8adedfd5da3a50b9c738755770edd98e5ccb" as const;
  const log = (address: Hex, topics: Hex[], data: Hex, logIndex: number) =>
    ({ address, topics, data, logIndex, blockNumber: 1n, blockHash: "0x01", transactionHash: "0x02", transactionIndex: 0, removed: false }) as unknown as Log;
  const cardSharded = (address: Hex, id: bigint, i: number) =>
    log(
      address,
      encodeEventTopics({ abi: abi.cardVault, eventName: "CardSharded", args: { id, shardToken: token, auction } }) as Hex[],
      encodeAbiParameters(
        [{ type: "uint16" }, { type: "uint16" }, { type: "uint64" }, { type: "uint64" }, { type: "uint256" }, { type: "uint256" }, { type: "uint128" }],
        [32, 8, 11_781_778n, 11_832_178n, 7n, 1n, 0n],
      ),
      i,
    );
  const noise = [
    // The card NFT into the vault (the vault's own ERC-721 Transfer, same address, other event).
    log(addresses.cardVault, encodeEventTopics({ abi: abi.cardVault, eventName: "Transfer", args: { from: owner, to: addresses.cardVault, tokenId: 1n } }) as Hex[], "0x", 0),
    // Shards minted to the auction and to the owner.
    log(token, encodeEventTopics({ abi: abi.shardToken, eventName: "Transfer", args: { from: "0x0000000000000000000000000000000000000000", to: auction } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [8n * 10n ** 18n]), 1),
    log(token, encodeEventTopics({ abi: abi.shardToken, eventName: "Transfer", args: { from: "0x0000000000000000000000000000000000000000", to: owner } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [24n * 10n ** 18n]), 2),
    // The CCA taking its tokens, and the factory announcing it.
    log(auction, encodeEventTopics({ abi: abi.ccaAuction, eventName: "TokensReceived" }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [8n * 10n ** 18n]), 3),
    // ENS state records for the card name.
    log(addresses.ensResolver, encodeEventTopics({ abi: abi.ensResolver, eventName: "TextUpdated", args: { recordId: 1n, keyHash: "vault.state" } }) as Hex[], encodeAbiParameters([{ type: "string" }, { type: "string" }], ["vault.state", "auctioning"]), 4),
  ];

  it("reads CardSharded from the vault's log among the token, auction and ENS logs", () => {
    expect(shardedFromLogs([...noise, cardSharded(addresses.cardVault, 1n, 5)])).toEqual({
      id: 1n, shardToken: getAddress(token), auction: getAddress(auction), totalShards: 32, forSale: 8, startBlock: 11_781_778n, endBlock: 11_832_178n,
    });
  });

  it("ignores a CardSharded emitted by any other contract", () => {
    expect(shardedFromLogs([cardSharded(auction, 1n, 0), ...noise])).toBeNull();
    expect(shardedFromLogs([cardSharded(token, 9n, 0), cardSharded(addresses.cardVault.toLowerCase() as Hex, 1n, 6)])?.id).toBe(1n);
  });

  it("returns null when there is no CardSharded", () => {
    expect(shardedFromLogs(noise)).toBeNull();
    expect(shardedFromLogs([cardSharded(addresses.cardVault, 2n, 0), cardSharded(addresses.cardVault, 1n, 5)], 1n)?.id).toBe(1n);
    expect(shardedFromLogs([cardSharded(addresses.cardVault, 2n, 0)], 1n)).toBeNull();
    expect(shardedFromLogs([])).toBeNull();
  });
});

describe("mintOutcome", () => {
  const hash = "0xabc" as const;
  it("reads the mint from the receipt", async () => {
    const out = await mintOutcome(hash, async () => ({ blockNumber: 7n, logs: [] }), () => ({ id: 2n, label: "x-lea-2", to: "0x01" as `0x${string}` }));
    expect(out).toEqual({ status: "minted", hash, blockNumber: 7n, id: 2n, label: "x-lea-2", to: "0x01" });
  });
  it("is terminal, with the hash, when the receipt can't be read", async () => {
    const out = await mintOutcome(hash, async () => { throw new Error("rpc down"); });
    expect(out).toEqual({ status: "details-unavailable", hash, reason: "rpc down" });
  });
  it("is terminal, with the hash, when the receipt has no CardMinted", async () => {
    const out = await mintOutcome(hash, async () => ({ blockNumber: 7n, logs: [] }));
    expect(out).toMatchObject({ status: "details-unavailable", hash });
  });
});
