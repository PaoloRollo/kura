import { describe, expect, it } from "vitest";
import { buildFeed, filterFeed, pageOf, pageWindow, usd, type FeedRow, type Part } from "@/lib/activity-feed";

type Hex = `0x${string}`;
const S = 10n ** 18n;
const U = 10n ** 6n;
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const ZERO = a(0);
const VAULT = a(0xfa), VENDOR = a(0xfe), SIGNER = a(0xf1), TOKEN = a(0x5a1d), AUCTION = a(0xa0c7), OLD = a(0xa0c6), OLD_TOKEN = a(0x5a1c);
const PAOLO = a(0xaa), KENJI = a(0xbb), AIKO = a(0xcc);
const parties = { vendor: VENDOR, signer: SIGNER, cardVault: VAULT };
const shardings = [
  { shardToken: TOKEN, auction: AUCTION, startBlock: 101n, endBlock: 101n + 50_400n, feeUsdc: 128_400_000n },
  { shardToken: OLD_TOKEN, auction: OLD, startBlock: 1n, endBlock: 301n, feeUsdc: null },
];
const ctx = { shardings, ensName: "black-lotus-lea-1.kura.eth", parties };

let n = 0;
function act(kind: FeedRow["kind"] & string, block: bigint, logIndex: number, actor: Hex, amount: bigint | null, meta: unknown) {
  n += 1;
  return { id: `0x${n}-${logIndex}`, kind: kind as never, actor, amount, meta, txHash: `0x${n.toString(16)}` as Hex, blockNumber: block, logIndex, timestamp: Number(block) * 12 };
}
const tr = (id: string, from: Hex, to: Hex, amount: bigint, block: bigint, token = TOKEN) => ({ id, shardToken: token, from, to, amount, blockNumber: block, timestamp: Number(block) * 12 });
const text = (parts: Part[]) => parts.map((p) => (typeof p === "string" ? p : `<${p.address}>`)).join("");

const activities = [
  act("mint", 10n, 4, PAOLO, null, { label: "black-lotus-lea-1" }),
  act("named", 10n, 3, PAOLO, null, { label: "black-lotus-lea-1", node: "0x01" }),
  act("shard", 100n, 1, PAOLO, 3n * S, { totalShards: 16, forSale: 3, auction: AUCTION, shardToken: TOKEN }),
  act("bid", 120n, 0, KENJI, 3424n * U, { auction: AUCTION, bidId: "1", maxUsdcPerShard: "1760000000" }),
  act("settle", 300n, 5, KENJI, 5136n * U, { graduated: true, shardToken: TOKEN, clearingUsdcPerShard: "1712000000" }),
  act("exit", 301n, 1, KENJI, 12_500_000n, { auction: AUCTION, bidId: "1", tokensFilled: (2n * S).toString() }),
  act("claim", 301n, 2, KENJI, 2n * S, { auction: AUCTION, bidId: "1" }),
  act("redeem", 400n, 1, PAOLO, 5136n * U, { buyoutPerShard: "1712000000", fee: "128400000", shardToken: TOKEN }),
  act("payout", 401n, 1, KENJI, 2568n * U, { shardUnits: (3n * S / 2n).toString(), shardToken: TOKEN }),
  act("transfer", 402n, 1, PAOLO, null, { to: AIKO }),
  act("release", 403n, 1, PAOLO, null, null),
];
const transfers = [
  tr("0xm-0", ZERO, PAOLO, 13n * S, 100n),        // mint: excluded
  tr("0xa-3", AUCTION, KENJI, 2n * S, 301n),      // claim out of the auction: excluded
  tr("0xv-1", KENJI, VAULT, 1n * S, 400n),        // into the vault (redeem): excluded
  tr("0xo-1", PAOLO, OLD, 1n * S, 50n, OLD_TOKEN), // into an earlier auction: excluded
  tr("0xb-0", ZERO, ZERO, 1n, 302n),              // nonsense burn: excluded
  tr("0xdead-7", KENJI, AIKO, S / 2n, 350n),      // holder to holder: kept
  tr("0xold-2", PAOLO, KENJI, 1n * S, 60n, OLD_TOKEN), // earlier sharding's token: kept
];
const records = [{ key: "condition", value: "NM", updatedBlock: 301n, updatedAt: 3612 }, { key: "appraisal.usd", value: "25000.00", updatedBlock: 5n, updatedAt: 60 }];
const feed = buildFeed({ activities, transfers, records, ctx });

describe("buildFeed", () => {
  it("merges activities, holder-to-holder shard transfers and ENS records, newest first", () => {
    expect(feed.map((r) => `${r.blockNumber}:${r.kind}`)).toEqual([
      "403:release", "402:transfer", "401:payout", "400:redeem", "350:shardTransfer",
      "301:record", "301:claim", "301:exit", "300:settle", "120:bid", "100:shard", "60:shardTransfer",
      "10:mint", "10:named", "5:record",
    ]);
  });

  it("parses the tx hash and log index of a shard transfer from its id", () => {
    const t = feed.find((r) => r.key === "0xdead-7")!;
    expect(t).toMatchObject({ txHash: "0xdead", logIndex: 7, title: "Transfer" });
    expect(text(t.who)).toBe(`<${KENJI}>→<${AIKO}>`);
    expect(text(t.detail)).toBe("0.5 shards");
  });

  it("places ENS records after their block's logs, without a transaction", () => {
    const r = feed.find((x) => x.kind === "record" && x.blockNumber === 301n)!;
    expect(r.txHash).toBeNull();
    expect(r.logIndex).toBe(Number.MAX_SAFE_INTEGER);
    expect(text(r.who)).toBe(`vendor<${VENDOR}>`);
    expect(text(r.detail)).toBe("condition = NM");
    expect(text(feed.find((x) => x.key === "record-appraisal.usd")!.who)).toBe(`<${SIGNER}>`);
  });

  it("writes each kind's row text in the right units", () => {
    const d = (kind: string) => text(feed.find((r) => r.kind === kind)!.detail);
    expect(d("bid")).toBe("$3,424 up to $1,760");
    expect(d("exit")).toBe("filled 2.0 shards · refund $12.50");
    expect(d("claim")).toBe("2.0 shards");
    expect(d("shard")).toBe("16 shards · 3 for sale · 1 week");
    expect(d("settle")).toBe("raised $5,136 · fee $128.40");
    expect(d("redeem")).toBe("buyout $1,712/shard · paid $5,136");
    expect(d("payout")).toBe("$2,568 for 1.5 shards");
    expect(d("named")).toBe("black-lotus-lea-1.kura.eth");
    expect(d("mint")).toBe(`to<${PAOLO}>`);
    expect(text(feed.find((r) => r.kind === "mint")!.who)).toBe(`vendor<${VENDOR}>`);
    expect(text(feed.find((r) => r.kind === "named")!.who)).toBe(`<${VAULT}>`);
    expect(text(feed.find((r) => r.kind === "transfer")!.who)).toBe(`<${PAOLO}>→<${AIKO}>`);
    expect(text(feed.find((r) => r.kind === "settle")!.who)).toBe(`anyone<${KENJI}>`);
  });

  it("has a short who for the Overview list: Minted · vendor, Settled · <caller>", () => {
    expect(text(feed.find((r) => r.kind === "mint")!.whoShort)).toBe("vendor");
    expect(text(feed.find((r) => r.kind === "settle")!.whoShort)).toBe(`<${KENJI}>`);
    expect(text(feed.find((r) => r.key === "record-condition")!.whoShort)).toBe("vendor");
    expect(text(feed.find((r) => r.kind === "bid")!.whoShort)).toBe(`<${KENJI}>`);
  });

  it("orders ENS records of one block by key", () => {
    const recs = ["url", "addr", "condition", "avatar"].map((key) => ({ key, value: "v", updatedBlock: 9n, updatedAt: 1 }));
    const rows = buildFeed({ activities: [], transfers: [], records: recs, ctx });
    expect(rows.map((r) => r.key)).toEqual(["record-addr", "record-avatar", "record-condition", "record-url"]);
  });

  it("says when the reserve was not met", () => {
    const [row] = buildFeed({ activities: [act("settle", 1n, 0, KENJI, 0n, { graduated: false, shardToken: TOKEN, clearingUsdcPerShard: null })], transfers: [], records: [], ctx });
    expect(text(row!.detail)).toBe("Reserve not met · refunded");
  });
});

describe("filters", () => {
  const kinds = (f: Parameters<typeof filterFeed>[1]) => filterFeed(feed, f).map((r) => r.kind);
  it("groups kinds as the Activity tab does; mint is under All only", () => {
    expect(kinds("all")).toHaveLength(feed.length);
    expect(kinds("bids")).toEqual(["claim", "exit", "bid"]);
    expect(kinds("transfers")).toEqual(["transfer", "shardTransfer", "shardTransfer"]);
    expect(kinds("settlement")).toEqual(["release", "payout", "redeem", "settle", "shard"]);
    expect(kinds("ens")).toEqual(["record", "named", "record"]);
    expect(["bids", "transfers", "settlement", "ens"].flatMap((f) => kinds(f as never))).not.toContain("mint");
  });
});

describe("pagination", () => {
  it("pages rows and clamps the page", () => {
    const rows = Array.from({ length: 47 }, (_, i) => i);
    expect(pageOf(rows, 1, 10)).toMatchObject({ from: 1, to: 10, total: 47, pages: 5, page: 1 });
    expect(pageOf(rows, 5, 10)).toMatchObject({ from: 41, to: 47 });
    expect(pageOf(rows, 9, 25)).toMatchObject({ page: 2, from: 26, to: 47 });
    expect(pageOf([], 1, 10)).toMatchObject({ from: 0, to: 0, total: 0, pages: 1 });
  });

  it("windows page buttons with gaps", () => {
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(1, 6)).toEqual([1, 2, 3, "gap", 6]);
    expect(pageWindow(5, 9)).toEqual([1, "gap", 4, 5, 6, "gap", 9]);
    expect(pageWindow(9, 9)).toEqual([1, "gap", 7, 8, 9]);
  });

  it("formats whole dollars without cents", () => {
    expect(usd(1712n * U)).toBe("$1,712");
    expect(usd(128_400_000n)).toBe("$128.40");
  });
});
