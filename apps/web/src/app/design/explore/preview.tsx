"use client";

import { CountdownHead } from "@/components/countdown";
import { useState } from "react";
import { ExploreView } from "@/components/explore-view";
import type { ExploreData } from "@/hooks/use-explore";
import { DEFAULT_FILTERS, buildAuctionItems, type ExploreFilters } from "@/lib/explore";
import { AIKO, HEAD, KENJI, PAOLO, REN, X7A3, activeRow, attributesOf, cardRow, metaOf, shardingRow, usd, type CardSpec, type CatalogKey, type ShardingSpec } from "../catalog";
import { PreviewShell } from "../preview-shell";
import { EXPLORE_PREVIEWS, type ExplorePreviewState } from "./states";

const H = 3600;
const D = 86_400;

// Four live auctions (TQ4jp), one past its end awaiting settle, one settled; five cards new in the vault.
const CARDS: (CardSpec & { market: number })[] = [
  { id: 1, key: "lotus", owner: PAOLO, ownerOf: PAOLO, state: "auctioning", mintedAgo: 7 * D, market: 25_000 },
  { id: 2, key: "recall", condition: "LP", owner: AIKO, state: "auctioning", mintedAgo: 5 * D, market: 22_822 },
  { id: 3, key: "jace", owner: KENJI, state: "auctioning", mintedAgo: 4 * D, market: 1_374 },
  { id: 4, key: "force", condition: "MP", owner: REN, state: "auctioning", mintedAgo: 3 * D, market: 620.8 },
  { id: 5, key: "walk", condition: "LP", language: "ja", owner: AIKO, state: "sharded", mintedAgo: 9 * D, market: 30_000 },
  { id: 6, key: "solring", owner: X7A3, state: "sharded", mintedAgo: 10 * D, market: 5_300 },
  { id: 7, key: "mox", owner: KENJI, state: "whole", mintedAgo: 120, market: 38_400 },
  { id: 8, key: "walk", owner: AIKO, state: "whole", mintedAgo: H, market: 30_000 },
  { id: 9, key: "solring", owner: X7A3, state: "whole", mintedAgo: 3 * H, market: 5_300 },
  { id: 10, key: "lotus", owner: PAOLO, state: "whole", mintedAgo: 5 * H, market: 25_000 },
  { id: 11, key: "recall", owner: REN, state: "whole", mintedAgo: 26 * H, market: 22_822 },
];

const left = (s: number, total: number): Pick<ShardingSpec, "openedAgo" | "length"> => ({ openedAgo: total - s, length: total });
const SHARDINGS: ShardingSpec[] = [
  { id: 1, totalShards: 16, forSale: 3, floor: 1560, clearing: 1712, ...left(252, 663) }, // 04:12 left, 62% elapsed
  { id: 2, totalShards: 32, forSale: 8, floor: 600, clearing: 662, ...left(1120, 1723) }, // 18:40, 35%
  { id: 3, totalShards: 64, forSale: 16, floor: 15, clearing: 17.5, ...left(2525, 12_625) }, // 42:05, 80%
  { id: 4, totalShards: 16, forSale: 4, floor: 35, clearing: 40, ...left(4350, 5438) }, // 1:12:30, 20%
  { id: 6, totalShards: 64, forSale: 12, floor: 300, clearing: 332, openedAgo: 7 * D + 600, length: 7 * D }, // ended, not settled
  { id: 5, totalShards: 16, forSale: 4, floor: 1700, clearing: 1840, openedAgo: 9 * D, length: 7 * D, settled: true, settledAgo: 2 * D },
];

function fixture(state: ExplorePreviewState, now: number): ExploreData {
  if (state === "loading") return { items: [], newCards: [], block: null, isLoading: true };
  if (state === "empty") return { items: [], newCards: [], block: HEAD, isLoading: false };
  const cards = CARDS.map((c) => cardRow(c, now));
  const shardings = SHARDINGS.map((s) => shardingRow(s, now));
  const metas = new Map(CARDS.map((c) => [String(c.id), metaOf(c.id, c.key)]));
  const items = buildAuctionItems({
    active: shardings.filter((s) => !s.settled).map(activeRow),
    shardings,
    cards,
    metas,
    attributes: attributesOf([...new Set(CARDS.map((c) => c.key))] as CatalogKey[]),
    markets: new Map(CARDS.map((c) => [String(c.id), usd(c.market)])),
    block: HEAD,
  });
  const newCards = CARDS.filter((c) => c.state === "whole").map((c) => ({ id: BigInt(c.id), name: metaOf(c.id, c.key).name.replace(/ \(.*$/, ""), image: metaOf(c.id, c.key).image, owner: c.owner, mintedAt: now - c.mintedAgo }));
  return { items, newCards, block: HEAD, isLoading: false };
}

const INITIAL: Partial<Record<ExplorePreviewState, Partial<ExploreFilters>>> = {
  filtered: { set: ["LEA", "LEB"], cond: ["NM", "LP"], vs: ["below"] },
  "no-results": { q: "black lotus japanese" },
  "filters-sheet": { set: ["LEA", "LEB"], cond: ["NM", "LP"] },
  "ending-soon": { tab: "soon" },
  upcoming: { tab: "upcoming" },
  ended: { tab: "ended" },
  list: { view: "list" },
};

export function ExplorePreview({ state, now }: { state: ExplorePreviewState; now: number }) {
  const [filters, setFilters] = useState<ExploreFilters>({ ...DEFAULT_FILTERS, ...INITIAL[state] });
  return (
    <PreviewShell base="/design/explore" states={EXPLORE_PREVIEWS} state={state} path="/app">
      <CountdownHead.Provider value={{ number: HEAD, timestamp: now }}>
        <ExploreView {...fixture(state, now)} filters={filters} onFilters={setFilters} now={now} defaultSheetOpen={state === "filters-sheet"} />
      </CountdownHead.Provider>
    </PreviewShell>
  );
}
