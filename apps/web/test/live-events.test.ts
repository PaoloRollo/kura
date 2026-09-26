// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usdcPerShardToQ96 } from "@kura/shared";
import type { Address, Hex } from "viem";

const state = vi.hoisted(() => ({
  active: [] as { auction: string; cardId: bigint; endBlock: bigint }[],
  cards: [] as { id: bigint; state: string; scryfallId: string; label: string; beneficialOwner: string }[],
  balances: [] as { shardToken: string; balance: bigint }[],
  block: 100n as bigint | null,
  client: null as null | { watchContractEvent: ReturnType<typeof import("vitest").vi.fn> },
  notify: null as null | ReturnType<typeof import("vitest").vi.fn>,
}));

vi.mock("@/lib/ponder", () => ({
  schema: { cards: "cards", activeAuctions: "activeAuctions", shardBalances: { holder: "holder" } },
  t: (x: unknown) => x,
}));
vi.mock("@ponder/client", () => ({ eq: () => null }));
vi.mock("@ponder/react", () => ({
  usePonderQuery: (p: { queryFn: (db: unknown) => unknown; enabled?: boolean }) => {
    let table = "";
    const chain = { where: () => chain, orderBy: () => chain };
    p.queryFn({ select: () => ({ from: (tbl: unknown) => ((table = typeof tbl === "string" ? tbl : "shardBalances"), chain) }) });
    if (p.enabled === false) return { data: undefined, isSuccess: false };
    const data = table === "cards" ? state.cards : table === "activeAuctions" ? state.active : state.balances;
    return { data, isSuccess: true };
  },
}));
vi.mock("@/hooks/use-explore", () => ({ useIndexerBlock: () => state.block, useAttributes: () => ({ "fx-lotus": { name: "Black Lotus" } }) }));
vi.mock("@/hooks/use-handles", () => ({ useHandles: () => ({}), displayName: (a: string) => (a === KENJI ? "kenji.kura.eth" : a) }));
vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ ready: true, authenticated: true, address: ME }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/chain", () => ({ addresses: { cardVault: "0x9999999999999999999999999999999999999999" }, wsClient: () => state.client }));
vi.mock("@/components/kura", () => ({ notify: (...a: unknown[]) => state.notify?.(...a) }));

const ME = "0x00000000000000000000000000000000000000aa";
const KENJI = "0x00000000000000000000000000000000000000bb";

import { subscribeLiveEvents, useLiveEvents, type LiveEvent } from "@/hooks/use-live-events";
import { labelName, liveAuctionsKey, liveEventFilter, liveToast, type LiveContext } from "@/lib/live-events";
import { rememberOwnTx } from "@/lib/tx-core";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const usd = (d: number) => BigInt(Math.round(d * 100)) * 10_000n;

function fakeClient() {
  const unwatchers: ReturnType<typeof vi.fn>[] = [];
  const calls: { address: string; eventName: string; onLogs: (logs: unknown[]) => void }[] = [];
  const client = {
    watchContractEvent: vi.fn((args: { address: string; eventName: string; onLogs: (logs: unknown[]) => void }) => {
      calls.push(args);
      const u = vi.fn();
      unwatchers.push(u);
      return u;
    }),
  };
  return { client, unwatchers, calls };
}

describe("subscribeLiveEvents", () => {
  it("watches each auction and the vault (settled and redeemed), and unsubscribes everything", () => {
    const { client, unwatchers, calls } = fakeClient();
    const stop = subscribeLiveEvents(client as never, { auctions: ["0x1", "0x2"] as never, vault: "0x9" as never, onEvent: vi.fn() });
    expect(client.watchContractEvent).toHaveBeenCalledTimes(4);
    expect(calls.map((c) => `${c.address}:${c.eventName}`)).toEqual(["0x1:BidSubmitted", "0x2:BidSubmitted", "0x9:AuctionSettled", "0x9:CardRedeemed"]);
    stop();
    for (const u of unwatchers) expect(u).toHaveBeenCalledTimes(1);
  });

  it("maps logs to events with the tx hash and log index, dropping removed logs", () => {
    const { client, calls } = fakeClient();
    const onEvent = vi.fn();
    subscribeLiveEvents(client as never, { auctions: ["0x1"] as never, vault: "0x9" as never, onEvent });
    calls[0]!.onLogs([
      { args: { id: 7n, owner: KENJI, priceQ96: 5n, amount: 10n }, transactionHash: hash(1), logIndex: 3 },
      { args: { id: 8n, owner: KENJI, priceQ96: 5n, amount: 10n }, transactionHash: hash(2), logIndex: 0, removed: true },
    ]);
    calls[2]!.onLogs([{ args: { id: 1n, shardToken: "0xt", redeemer: KENJI, buyoutPerShard: 1n, payoutUsdc: 2n, feeUsdc: 0n }, transactionHash: hash(3), logIndex: 1 }]);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0]![0]).toMatchObject({ kind: "bid", auction: "0x1", bidId: 7n, owner: KENJI, priceQ96: 5n, amount: 10n, txHash: hash(1), logIndex: 3 });
    expect(onEvent.mock.calls[1]![0]).toMatchObject({ kind: "redeemed", cardId: 1n, redeemer: KENJI, txHash: hash(3), logIndex: 1 });
  });
});

const bid = (over: Partial<Extract<LiveEvent, { kind: "bid" }>> = {}): LiveEvent => ({
  kind: "bid", auction: "0xa1" as Address, bidId: 1n, owner: KENJI as Address, priceQ96: usdcPerShardToQ96(usd(1760)), amount: usd(2568),
  txHash: hash(10), logIndex: 0, ...over,
});

describe("liveEventFilter", () => {
  it("drops a replayed log, my own transaction and events I caused", () => {
    const f = liveEventFilter();
    const keep = (e: LiveEvent) => f(e, ME);
    expect(keep(bid())).toBe(true);
    expect(keep(bid())).toBe(false); // same txHash-logIndex (a reconnect replay)
    expect(keep(bid({ logIndex: 1 }))).toBe(true);
    rememberOwnTx(hash(11));
    expect(keep(bid({ txHash: hash(11) }))).toBe(false);
    expect(keep(bid({ txHash: hash(12), owner: ME.toUpperCase().replace("0X", "0x") as Address }))).toBe(false);
    const redeem: LiveEvent = { kind: "redeemed", cardId: 1n, shardToken: "0xt" as Address, redeemer: ME as Address, buyoutPerShard: 1n, payoutUsdc: 1n, feeUsdc: 0n, txHash: hash(13), logIndex: 0 };
    expect(keep(redeem)).toBe(false);
  });
});

describe("liveToast", () => {
  const ctx = (over: Partial<LiveContext> = {}): LiveContext => ({
    me: ME,
    auctionCard: (a) => (a === "0xa1" ? 1n : null),
    card: (id) => (id === 1n ? { name: "Black Lotus", owner: ME } : id === 2n ? { name: "Time Walk", owner: KENJI } : null),
    balance: () => 0n,
    name: (a) => (a === KENJI ? "kenji.kura.eth" : a),
    ...over,
  });

  it("a bid on my card, with the bidder, amount and max", () => {
    expect(liveToast(bid(), ctx())).toEqual({
      title: "New bid on your Black Lotus",
      body: "kenji.kura.eth · $2,568 up to $1,760",
      tone: "shu",
      icon: "bid",
      action: { label: "View", href: "/app/cards/1?tab=auction" },
    });
    expect(liveToast(bid(), ctx({ me: KENJI }))?.title).toBe("New bid on Black Lotus");
    expect(liveToast(bid({ auction: "0xzz" as Address }), ctx())).toBeNull();
  });

  it("a settlement: shards sold and raised, or reserve not met", () => {
    const settled: LiveEvent = { kind: "settled", cardId: 1n, shardToken: "0xt" as Address, clearingPriceQ96: usdcPerShardToQ96(usd(1712)), raisedUsdc: usd(5136), feeUsdc: usd(128.4), graduated: true, txHash: hash(20), logIndex: 0 };
    expect(liveToast(settled, ctx())).toMatchObject({ title: "Your auction settled", body: "3 Black Lotus shards sold · $5,136", tone: "good", icon: "settled" });
    expect(liveToast({ ...settled, cardId: 2n, graduated: false }, ctx())).toMatchObject({ title: "Auction settled", body: "Reserve not met · bids refunded" });
  });

  it("a buyout: my payout when I hold shards, else the price", () => {
    const redeemed: LiveEvent = { kind: "redeemed", cardId: 2n, shardToken: "0xt" as Address, redeemer: KENJI as Address, buyoutPerShard: usd(1840), payoutUsdc: 0n, feeUsdc: 0n, txHash: hash(30), logIndex: 0 };
    expect(liveToast(redeemed, ctx())).toMatchObject({ title: "Time Walk was bought out", body: "by kenji.kura.eth at $1,840/shard", tone: "kin", action: { label: "View", href: "/app/cards/2" } });
    expect(liveToast(redeemed, ctx({ balance: () => 10n ** 18n }))).toMatchObject({ body: "Payout ready: $1,840 · by kenji.kura.eth", action: { label: "Claim", href: "/app/cards/2" } });
  });

  it("helpers: the live key ignores ended auctions; label names", () => {
    expect(liveAuctionsKey([{ auction: "0xB", endBlock: 200n }, { auction: "0xA", endBlock: 150n }, { auction: "0xC", endBlock: 100n }], 100n)).toBe("0xa,0xb");
    expect(labelName("black-lotus-lea-1")).toBe("Black Lotus");
  });
});

describe("useLiveEvents", () => {
  const A1 = "0x00000000000000000000000000000000000000a1";
  const A2 = "0x00000000000000000000000000000000000000a2";
  beforeEach(() => {
    process.env.NEXT_PUBLIC_ALCHEMY_WS_URL = "wss://example.test";
    state.active = [{ auction: A1, cardId: 1n, endBlock: 500n }];
    state.cards = [{ id: 1n, state: "auctioning", scryfallId: "fx-lotus", label: "black-lotus-lea-1", beneficialOwner: ME }];
    state.balances = [];
    state.block = 100n;
    state.notify = vi.fn();
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ALCHEMY_WS_URL;
  });

  it("subscribes once per auction set, re-subscribes on change and stops on unmount", () => {
    const f = fakeClient();
    state.client = f.client;
    const h = renderHook(() => useLiveEvents());
    expect(f.client.watchContractEvent).toHaveBeenCalledTimes(3);
    h.rerender();
    state.block = 101n; // new block, same live set: no second subscription
    h.rerender();
    expect(f.client.watchContractEvent).toHaveBeenCalledTimes(3);

    state.active = [...state.active, { auction: A2, cardId: 2n, endBlock: 500n }];
    h.rerender();
    expect(f.unwatchers.slice(0, 3).every((u) => u.mock.calls.length === 1)).toBe(true);
    expect(f.client.watchContractEvent).toHaveBeenCalledTimes(3 + 4);

    h.unmount();
    expect(f.unwatchers.every((u) => u.mock.calls.length === 1)).toBe(true);
  });

  it("toasts someone else's bid once, through notify", () => {
    const f = fakeClient();
    state.client = f.client;
    renderHook(() => useLiveEvents());
    const log = { args: { id: 1n, owner: KENJI, priceQ96: usdcPerShardToQ96(usd(1760)), amount: usd(2568) }, transactionHash: hash(40), logIndex: 2 };
    f.calls[0]!.onLogs([log, log]);
    expect(state.notify).toHaveBeenCalledTimes(1);
    expect(state.notify!.mock.calls[0]![0]).toMatchObject({ title: "New bid on your Black Lotus", body: "kenji.kura.eth · $2,568 up to $1,760", tone: "shu", duration: 6000 });
  });

  it("does nothing without NEXT_PUBLIC_ALCHEMY_WS_URL", () => {
    delete process.env.NEXT_PUBLIC_ALCHEMY_WS_URL;
    const f = fakeClient();
    state.client = f.client;
    renderHook(() => useLiveEvents());
    expect(f.client.watchContractEvent).not.toHaveBeenCalled();
  });
});
