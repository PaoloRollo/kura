"use client";

import { useEffect, useMemo, useState } from "react";
import { usdcPerShardToQ96 } from "@kura/shared";
import { MyShardsView } from "@/components/my-shards-view";
import { PortfolioView, type PortfolioTab } from "@/components/portfolio-view";
import { PayoutClaimedView, showVaultSuccess, useVaultSuccess } from "@/components/vault-success";
import { VaultIoContext, type VaultIo, type VaultRead } from "@/components/vault-io";
import type { PortfolioData, ShardingRow } from "@/hooks/use-portfolio";
import { allocation, bidItems, holdings, payouts, totals, wholeCards } from "@/lib/portfolio";
import { AIKO, CATALOG, HEAD, KENJI, PAOLO, S, activeRow, addr, cardRow, hash, shardingRow, usd, type CardSpec, type CatalogKey, type ShardingSpec } from "../catalog";
import { cardFixture } from "../card/fixtures";
import { PreviewShell } from "../preview-shell";
import { PORTFOLIO_PREVIEWS, type PortfolioPreviewState } from "./states";

const D = 86_400;
const ME = PAOLO;

// QEEV7: Black Lotus (sharded by me, 13 of 16), Ancestral Recall (live, 2.5 sent to me, so no cost basis), Sol Ring (6 of 64), Time Walk bought out
// by aiko; Mox Sapphire and Jace whole; Force of Will taken home. K7qgeI's bids on other auctions.
const CARDS: (CardSpec & { market?: number })[] = [
  { id: 1, key: "lotus", owner: ME, ownerOf: addr(0x777), state: "sharded", mintedAgo: 9 * D },
  { id: 2, key: "recall", owner: AIKO, ownerOf: addr(0x777), state: "auctioning", mintedAgo: 8 * D },
  { id: 3, key: "solring", owner: KENJI, ownerOf: addr(0x777), state: "sharded", mintedAgo: 8 * D },
  { id: 4, key: "walk", owner: AIKO, state: "whole", mintedAgo: 12 * D },
  { id: 5, key: "mox", owner: ME, state: "whole", mintedAgo: 2 * D, market: 38_400 },
  { id: 6, key: "jace", owner: ME, state: "whole", mintedAgo: 3 * D, market: 1_120 },
  { id: 7, key: "force", owner: ME, state: "released", mintedAgo: 20 * D },
  { id: 10, key: "lotus", owner: KENJI, ownerOf: addr(0x777), state: "auctioning", mintedAgo: 4 * D },
  { id: 11, key: "jace", owner: AIKO, ownerOf: addr(0x777), state: "auctioning", mintedAgo: 4 * D },
  { id: 12, key: "recall", owner: KENJI, ownerOf: addr(0x777), state: "sharded", mintedAgo: 6 * D },
  { id: 13, key: "walk", owner: KENJI, ownerOf: addr(0x777), state: "sharded", mintedAgo: 6 * D },
];
const SHARDINGS: ShardingSpec[] = [
  { id: 1, totalShards: 16, forSale: 3, floor: 1560, clearing: 1712, openedAgo: 7 * D, length: 6 * D, settled: true },
  { id: 2, totalShards: 32, forSale: 8, floor: 1100, clearing: 1256, openedAgo: 6 * D, length: 6 * D + 720 },
  { id: 3, totalShards: 64, forSale: 12, floor: 300, clearing: 332, openedAgo: 6 * D, length: 5 * D, settled: true },
  { id: 4, totalShards: 16, forSale: 4, floor: 1700, clearing: 1800, openedAgo: 11 * D, length: 7 * D, settled: true, buyout: 1840, redeemer: AIKO },
  { id: 10, totalShards: 16, forSale: 3, floor: 1600, clearing: 1712, openedAgo: 2 * D, length: 3 * D },
  { id: 11, totalShards: 64, forSale: 16, floor: 15, clearing: 17.5, openedAgo: 2 * D, length: 3 * D },
  { id: 12, totalShards: 32, forSale: 8, floor: 600, clearing: 662, openedAgo: 5 * D, length: 4 * D, settled: true },
  { id: 13, totalShards: 16, forSale: 4, floor: 1650, clearing: 1700, openedAgo: 5 * D, length: 4 * D, settled: true },
];

function bid(n: number, card: number, amount: number, max: number, status: "open" | "exited" | "claimed", filled: bigint | null, refunded: bigint | null) {
  const s = shardingRow(SHARDINGS.find((x) => x.id === card)!, 0);
  return {
    id: `bid-${n}`, auction: s.auction, bidId: BigInt(n), cardId: BigInt(card), shardToken: s.shardToken, owner: ME, maxPriceQ96: usdcPerShardToQ96(usd(max)),
    amountUsdc: usd(amount), submittedBlock: HEAD - 1000n, submittedAt: 1000 + n, status, tokensFilled: filled, currencyRefunded: refunded, updatedBlock: HEAD, updatedAt: 0,
  };
}

function portfolioFixture(state: PortfolioPreviewState, now: number): PortfolioData {
  const base: PortfolioData = {
    me: ME, holdings: [], payouts: [], whole: [], released: [], bids: { live: [], ended: [] }, totals: { value: 0n, gain: 0n, cards: 0 }, allocation: [],
    usdc: usd(248.5), verified: true, handle: state === "no-handle" ? null : "paolo", block: HEAD, isLoading: state === "loading",
  };
  if (state === "empty" || state === "loading") return base;
  const cards = CARDS.map((c) => cardRow(c, now));
  const shardings = SHARDINGS.map((s) => shardingRow(s, now)) as ShardingRow[];
  const tokenOf = (id: number) => shardings.find((s) => s.cardId === BigInt(id))!.shardToken;
  const balances = [
    { shardToken: tokenOf(1), holder: ME, balance: 13n * S },
    { shardToken: tokenOf(2), holder: ME, balance: 5n * S / 2n },
    { shardToken: tokenOf(3), holder: ME, balance: 6n * S },
    { shardToken: tokenOf(4), holder: ME, balance: S },
  ];
  const bids = [
    bid(2, 3, 2064, 400, "claimed", 6n * S, 0n), // Sol Ring: avg $344
    bid(3, 10, 500, 1760, "open", null, null),
    bid(4, 11, 60, 16, "open", null, null),
    bid(5, 12, 1000, 700, "open", null, null),
    bid(6, 13, 400, 1600, "exited", 0n, usd(400)),
  ];
  const activities = [{ kind: "shard", cardId: 1n, actor: ME, meta: { shardToken: tokenOf(1), totalShards: 16, forSale: 3 } }];
  const active = shardings.filter((s) => !s.settled).map(activeRow);
  const ident = (id: bigint) => {
    const key = CARDS.find((c) => BigInt(c.id) === id)!.key as CatalogKey;
    return { name: CATALOG[key].name, image: CATALOG[key].image };
  };
  const market = (id: bigint) => { const m = CARDS.find((c) => BigInt(c.id) === id)?.market; return m != null ? usd(m) : null; };
  const h = holdings({ me: ME, balances, shardings, cards, bids, activities, active, block: HEAD, ident });
  const w = wholeCards(ME, cards, ident, market);
  const d: PortfolioData = {
    ...base,
    holdings: h,
    payouts: payouts(ME, balances, shardings).map((s) => ({ sharding: s, name: ident(s.cardId).name })),
    whole: w.whole,
    released: w.released.map((r) => ({ ...r, ensName: cards.find((c) => c.id === r.cardId)!.ensName, releasedAt: now - 3 * D })),
    bids: bidItems({ me: ME, bids, shardings, active, block: HEAD, ident }),
    totals: totals(h, w.whole),
    allocation: allocation(h, w.whole),
  };
  if (state === "empty-tab") return { ...d, whole: [], released: [] };
  return d;
}

/** Chain reads for the payout banner and My shards: 1 Time Walk shard, and the card fixture's balances. */
function fakeRead(me: `0x${string}`) {
  return async <T,>(req: VaultRead): Promise<T> => {
    if (req.functionName === "totalSupply") return (16n * S) as T;
    if (req.functionName === "balanceOf") {
      const walk = shardingRow(SHARDINGS[3]!, 0).shardToken;
      if (req.address.toLowerCase() === walk.toLowerCase()) return S as T;
      return (me === PAOLO ? 13n * S : 3n * S / 2n) as T;
    }
    return 0n as T;
  };
}
const fakeSend = async () => {
  await new Promise((r) => setTimeout(r, 900));
  return { hash: hash(0xc1a1), receipt: { status: "success", blockNumber: 1n, logs: [], transactionHash: hash(0xc1a1) } as never, gas: "sponsored" as const };
};

export function PortfolioPreview({ state, now }: { state: PortfolioPreviewState; now: number }) {
  const detail = state === "detail-seller" || state === "detail-buyer";
  const me = state === "detail-buyer" ? KENJI : PAOLO;
  const [tab, setTab] = useState<PortfolioTab>(state === "whole" || state === "empty-tab" ? "whole" : state === "bids" ? "bids" : "shards");
  const io = useMemo<Partial<VaultIo>>(() => ({ read: fakeRead(me), send: fakeSend, walletKind: "embedded" }), [me]);
  const success = useVaultSuccess();
  useEffect(() => {
    if (state === "claimed") showVaultSuccess({ kind: "claimed", cardId: 4n, hash: hash(0xc1a1), shardUnits: S, usdc: usd(1840), buyoutPerShard: usd(1840), redeemer: AIKO });
    return () => showVaultSuccess(null);
  }, [state]);

  let body;
  if (detail) {
    const c = cardFixture("sharded", now);
    const mine = c.holders.find((x) => x.holder === me)?.balance ?? 0n;
    body = <MyShardsView c={{ ...c, myBalance: mine }} me={me} now={now} binding={me === KENJI ? { boundAt: now - 2 * D, blockNumber: HEAD - 14_400n } : null} feeBps={250} />;
  } else if (success?.kind === "claimed") {
    body = <PayoutClaimedView info={success} cardName="Time Walk" onClose={() => showVaultSuccess(null)} />;
  } else {
    body = <PortfolioView d={portfolioFixture(state, now)} tab={tab} onTab={setTab} />;
  }
  return (
    <VaultIoContext.Provider value={io}>
      <PreviewShell base="/design/portfolio" states={PORTFOLIO_PREVIEWS} state={state} path="/app/portfolio" detail={detail}>{body}</PreviewShell>
    </VaultIoContext.Provider>
  );
}
