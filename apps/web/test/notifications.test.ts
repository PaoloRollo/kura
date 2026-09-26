import { describe, expect, it } from "vitest";
import { usdcPerShardToQ96 } from "@kura/shared";
import { deriveNotifications, isUnread, readSeen, writeSeen, type NotificationInput } from "@/lib/notifications";

type Hex = `0x${string}`;
const a = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const S = 10n ** 18n;
const usd = (d: number) => BigInt(Math.round(d * 100)) * 10_000n;
const q = (d: number) => usdcPerShardToQ96(usd(d));

const ME = a(0xaa);
const KENJI = a(0xbb);
const AIKO = a(0xcc);
const VAULT = a(0x99);
const NOW = 1_800_000_000;
const BLOCK = 1_000n;

const sharding = (n: number, over: Partial<NotificationInput["shardings"][number]> = {}): NotificationInput["shardings"][number] => ({
  shardToken: a(0x100 + n), cardId: BigInt(n), auction: a(0x200 + n), totalShards: 16, floorPriceQ96: q(1000), endBlock: 5_000n, settled: false,
  graduated: null, clearingUsdcPerShard: null, raisedUsdc: null, feeUsdc: null, buyoutPerShard: null, redeemer: null, updatedAt: NOW - 600, ...over,
});
const bid = (n: number, max: number, over: Partial<NotificationInput["bids"][number]> = {}): NotificationInput["bids"][number] => ({
  auction: a(0x200 + n), owner: ME, maxPriceQ96: q(max), status: "open", submittedAt: NOW - 3600, ...over,
});
const NAMES: Record<number, string> = { 1: "Black Lotus", 2: "Time Walk", 3: "Ancestral Recall" };

function input(over: Partial<NotificationInput> = {}): NotificationInput {
  return {
    me: ME, block: BLOCK, now: NOW, vault: VAULT,
    cards: [], shardings: [], active: [], bids: [], checkpoints: [], activities: [], balances: [], payoutClaims: [], transfers: [],
    cardName: (id) => NAMES[Number(id)] ?? `card #${id}`,
    name: (x) => (x === KENJI ? "kenji.kura.eth" : x === AIKO ? "aiko.kura.eth" : x),
    ...over,
  };
}

const live1 = { shardings: [sharding(1)], active: [{ auction: a(0x201), endBlock: 5_000n }] };

describe("deriveNotifications", () => {
  it("outbid: the clearing passed my max on a live auction", () => {
    const rows = deriveNotifications(input({
      ...live1,
      bids: [bid(1, 1760)],
      checkpoints: [
        { auction: a(0x201), blockNumber: 900n, clearingPriceQ96: q(1700), timestamp: NOW - 1800 },
        { auction: a(0x201), blockNumber: 990n, clearingPriceQ96: q(1772), timestamp: NOW - 120 },
      ],
    }));
    expect(rows).toEqual([{
      id: `outbid-${a(0x201)}`, kind: "outbid", cardId: 1n, title: "You were outbid on Black Lotus", body: "Clearing $1,772.00 passed your $1,760.00 max",
      time: NOW - 120, href: "/app/cards/1?tab=auction", action: "Raise bid",
    }]);
  });

  it("an exited bid, a bid at the clearing or a bid on an ended auction is never outbid", () => {
    const cps = [{ auction: a(0x201), blockNumber: 990n, clearingPriceQ96: q(1772), timestamp: NOW - 120 }];
    expect(deriveNotifications(input({ ...live1, bids: [bid(1, 1760, { status: "exited" })], checkpoints: cps }))).toEqual([]);
    expect(deriveNotifications(input({ ...live1, bids: [bid(1, 1772)], checkpoints: cps }))).toEqual([]);
    expect(deriveNotifications(input({ ...live1, active: [{ auction: a(0x201), endBlock: BLOCK }], bids: [bid(1, 1760)], checkpoints: cps }))).toEqual([]);
    // Another of my bids is still in.
    expect(deriveNotifications(input({ ...live1, bids: [bid(1, 1760), bid(1, 1800)], checkpoints: cps }))).toEqual([]);
  });

  it("payout ready: bought out, I hold shards and have not claimed", () => {
    const s = sharding(2, { redeemer: AIKO, buyoutPerShard: usd(1840), settled: true, updatedAt: NOW - 900 });
    const base = input({
      shardings: [s],
      balances: [{ shardToken: s.shardToken, holder: ME, balance: S, updatedAt: NOW - 5000 }],
      activities: [{ id: "r", kind: "redeem", cardId: 2n, actor: AIKO, amount: 0n, meta: { shardToken: s.shardToken }, timestamp: NOW - 840 }],
    });
    expect(deriveNotifications(base)).toEqual([{
      id: `payout-${s.shardToken}`, kind: "payout", cardId: 2n, title: "Payout ready: $1,840.00", body: "Time Walk was bought out by aiko.kura.eth",
      time: NOW - 840, href: "/app/cards/2", action: "Claim",
    }]);
    // A claimed payout is not "ready".
    expect(deriveNotifications({ ...base, payoutClaims: [{ shardToken: s.shardToken, holder: ME }] })).toEqual([]);
  });

  it("ends soon: a live auction I'm in with at most 50 blocks left", () => {
    const rows = deriveNotifications(input({
      shardings: [sharding(3, { endBlock: BLOCK + 50n })],
      active: [{ auction: a(0x203), endBlock: BLOCK + 50n }],
      bids: [bid(3, 700)],
      checkpoints: [{ auction: a(0x203), blockNumber: 990n, clearingPriceQ96: q(662), timestamp: NOW - 100 }],
    }));
    expect(rows).toEqual([{
      id: `ends-${a(0x203)}`, kind: "ends-soon", cardId: 3n, title: "Ancestral Recall ends in 10 minutes", body: "You're in at $662.00 per shard",
      time: NOW, href: "/app/cards/3?tab=auction",
    }]);
    // Anchored on chain time: a lagging indexer (same block, later clock) keeps the row's time.
    const lag = (now: number) => deriveNotifications(input({
      now,
      shardings: [sharding(3, { endBlock: BLOCK + 50n })],
      active: [{ auction: a(0x203), endBlock: BLOCK + 50n }],
      bids: [bid(3, 700)],
      checkpoints: [{ auction: a(0x203), blockNumber: 900n, clearingPriceQ96: q(662), timestamp: NOW - 1300 }],
    }))[0]?.time;
    expect(lag(NOW)).toBe(NOW - 100);
    expect(lag(NOW + 600)).toBe(NOW - 100);
    expect(lag(NOW + 3600)).toBe(NOW - 100);
    // 51 blocks left: not yet.
    expect(deriveNotifications(input({ shardings: [sharding(3, { endBlock: BLOCK + 51n })], active: [{ auction: a(0x203), endBlock: BLOCK + 51n }], bids: [bid(3, 700)] }))).toEqual([]);
  });

  it("your auction settled: a settle on a sharding I started", () => {
    const s = sharding(1, { settled: true, graduated: true, clearingUsdcPerShard: usd(1712), raisedUsdc: usd(5136), feeUsdc: usd(128.4) });
    const shard = { id: "s", kind: "shard", cardId: 1n, actor: ME, amount: 16n * S, meta: { shardToken: s.shardToken }, timestamp: NOW - 90_000 };
    const settle = { id: "t", kind: "settle", cardId: 1n, actor: KENJI, amount: usd(5136), meta: { shardToken: s.shardToken, graduated: true }, timestamp: NOW - 1320 };
    expect(deriveNotifications(input({ shardings: [s], activities: [shard, settle] }))).toEqual([{
      id: "settled-t", kind: "settled", cardId: 1n, title: "Your auction settled", body: "3 Black Lotus shards sold · +$5,007.60", time: NOW - 1320, href: "/app/cards/1?tab=auction",
    }]);
    // Reserve not met.
    const miss = sharding(1, { settled: true, graduated: false });
    expect(deriveNotifications(input({ shardings: [miss], activities: [shard, settle] }))[0]?.body).toBe("Reserve not met · bids refunded");
    // Someone else's auction.
    expect(deriveNotifications(input({ shardings: [s], activities: [{ ...shard, actor: KENJI }, settle] }))).toEqual([]);
  });

  it("received shards: from a person, not the auction, the vault or a mint", () => {
    const s = sharding(1, { settled: true });
    const tr = (id: string, from: Hex) => ({ id, shardToken: s.shardToken, from, to: ME, amount: S / 2n, timestamp: NOW - 3600 });
    const rows = deriveNotifications(input({
      shardings: [s],
      balances: [{ shardToken: s.shardToken, holder: ME, balance: (27n * S) / 2n, updatedAt: NOW - 3600 }],
      transfers: [tr("k", KENJI), tr("auction", s.auction), tr("vault", VAULT), tr("mint", a(0))],
    }));
    expect(rows).toEqual([{
      id: "received-k", kind: "received", cardId: 1n, title: "kenji.kura.eth sent you 0.5 shard", body: "Black Lotus · you now hold 13.5", time: NOW - 3600, href: "/app/cards/1",
    }]);
  });

  it("can redeem: 80% of a sharded card's supply", () => {
    const s = sharding(1, { settled: true, graduated: true });
    const card = { id: 1n, state: "sharded", shardToken: s.shardToken };
    const bal = (units: bigint) => [{ shardToken: s.shardToken, holder: ME, balance: units, updatedAt: NOW - 3700 }];
    expect(deriveNotifications(input({ cards: [card], shardings: [s], balances: bal(13n * S) }))).toEqual([{
      id: `redeem-${s.shardToken}`, kind: "can-redeem", cardId: 1n, title: "You can redeem Black Lotus", body: "You hold 81.3% of the shards", time: NOW - 3700, href: "/app/cards/1", action: "Redeem",
    }]);
    expect(deriveNotifications(input({ cards: [card], shardings: [s], balances: bal(12n * S) }))).toEqual([]);
    expect(deriveNotifications(input({ cards: [{ ...card, state: "auctioning" }], shardings: [s], balances: bal(13n * S) }))).toEqual([]);
  });

  it("sorts newest first", () => {
    const s = sharding(1, { settled: true, graduated: true });
    const rows = deriveNotifications(input({
      cards: [{ id: 1n, state: "sharded", shardToken: s.shardToken }],
      shardings: [s],
      balances: [{ shardToken: s.shardToken, holder: ME, balance: 13n * S, updatedAt: NOW - 3700 }],
      transfers: [{ id: "k", shardToken: s.shardToken, from: KENJI, to: ME, amount: S, timestamp: NOW - 60 }],
    }));
    expect(rows.map((r) => r.kind)).toEqual(["received", "can-redeem"]);
  });
});

describe("read state", () => {
  it("unread after the last seen time; storage failures read as never seen", () => {
    expect(isUnread({ time: 10 }, 9)).toBe(true);
    expect(isUnread({ time: 10 }, 10)).toBe(false);
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    writeSeen("0xABC", 42);
    expect(store.get("kura.notif.seen.0xabc")).toBe("42");
    expect(readSeen("0xabc")).toBe(42);
    g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readSeen("0xabc")).toBe(0);
    expect(() => writeSeen("0xabc", 1)).not.toThrow();
    g.localStorage = before;
  });
});
