// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@ponder/react", () => ({ usePonderQuery: () => ({ data: undefined, isSuccess: false }), usePonderStatus: () => ({ data: undefined }) }));
vi.mock("@/lib/chain", async (orig) => ({ ...(await orig<object>()), publicClient: { readContract: async () => 250n } }));
class RO { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;

import { CardAnalytics, cardAnalyticsView, lastPerBucket } from "@/components/card-analytics";
import type { BalanceRow, CardData } from "@/hooks/use-card";
import { HandlesFixture } from "@/hooks/use-handles";
import { HANDLES, KENJI, PAOLO, cardFixture, type PreviewState } from "@/app/design/card/fixtures";

afterEach(cleanup);

const NOW = 1_790_000_000;
const S = 10n ** 18n;

function renderAnalytics(c: CardData) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <HandlesFixture.Provider value={HANDLES}>
        <CardAnalytics data={c} now={NOW} market={[]} />
      </HandlesFixture.Provider>
    </QueryClientProvider>,
  );
}

const kpi = (label: string) => {
  const tile = screen.getByText(label, { selector: "div" }).closest("[data-slot=stat-tile]") as HTMLElement;
  return within(tile);
};
const view = (state: PreviewState, patch: Partial<CardData> = {}) => cardAnalyticsView({ data: { ...cardFixture(state, NOW), ...patch }, now: NOW, market: [], feeBps: 250 })!;
const tile = (v: ReturnType<typeof view>, label: string) => v.kpis.find((k) => k.label === label)!;

describe("CardAnalytics", () => {
  it("reads n/a for implied value and premium and 0% fill when the reserve was not met", () => {
    renderAnalytics(cardFixture("reserve-not-met", NOW));
    expect(kpi("Implied value").getByText("n/a")).toBeTruthy();
    expect(kpi("Implied value").getByText("reserve not met")).toBeTruthy();
    expect(kpi("Premium").getByText("n/a")).toBeTruthy();
    expect(kpi("Fill rate").getByText("0%")).toBeTruthy();
    expect(kpi("Fill rate").getByText("reserve not met · all refunded")).toBeTruthy();
    // Demand still renders; no settle chip on the price bars.
    expect(screen.getByLabelText("Demand by price level")).toBeTruthy();
    expect(view("reserve-not-met").price.marks.map((m) => m.label)).not.toContain("S");
    expect(view("reserve-not-met").price.settledAt).toBeUndefined();
  });

  it("shows the settled card as in LqnA2", async () => {
    renderAnalytics(cardFixture("sharded", NOW));
    expect(kpi("Implied value").getByText("$27,392.00")).toBeTruthy();
    expect(kpi("Premium").getByText("+9.6%")).toBeTruthy();
    expect(kpi("Concentration").getByText("0.67")).toBeTruthy();
    expect(kpi("To redemption").getByText("eligible")).toBeTruthy();
    expect(kpi("Fill rate").getByText("100%")).toBeTruthy();
    expect(kpi("Fill rate").getByText("3 of 3 shards sold")).toBeTruthy();
    expect(screen.getByText(/Market \$1,562\.50 \/ shard, flat over the window/)).toBeTruthy();
    // The lowest level still in the money ($1,760.00) is marked; the note gives the clearing itself.
    expect(document.querySelector("[data-clearing]")?.textContent).toContain("$1,760.00");
    expect(screen.getByText("Clears at $1,712.00 where demand covers the 3 shards for sale.")).toBeTruthy();
    expect(screen.getByText("$128.40", { selector: "dd.text-kin" })).toBeTruthy();
    expect(await screen.findByText("2.5% of proceeds, paid at settle and on buyout.")).toBeTruthy();
  });

  it("is eligible for a top holder at 13/16 with 2 shards unclaimed in the auction", () => {
    const c = cardFixture("sharded", NOW);
    const auction = c.sharding!.auction;
    const holders: BalanceRow[] = [
      { ...c.holders[0]!, holder: PAOLO, balance: 13n * S },
      { ...c.holders[0]!, holder: KENJI, balance: 1n * S },
      { ...c.holders[0]!, holder: auction, balance: 2n * S },
    ];
    const v = view("sharded", { holders, supply: 16n * S });
    expect(tile(v, "To redemption")).toMatchObject({ value: "eligible", tone: "kin", sub: "top holder 81.3%" });
    expect(v.ownership.slices.at(-1)).toMatchObject({ id: "unclaimed", name: "Unclaimed in auction", value: 0.125 });
    expect(view("auctioning").ownership.slices.at(-1)).toMatchObject({ id: "unclaimed", name: "In auction" });
  });

  it("is 2.8 shards short at 10/16", () => {
    const c = cardFixture("sharded", NOW);
    const holders: BalanceRow[] = [
      { ...c.holders[0]!, holder: PAOLO, balance: 10n * S },
      { ...c.holders[0]!, holder: KENJI, balance: 6n * S },
    ];
    renderAnalytics({ ...cardFixture("sharded", NOW), holders, supply: 16n * S });
    expect(kpi("To redemption").getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "2.8 shards short" && el.parentElement?.tagName === "DIV")).toBeTruthy();
  });

  it("labels a live auction and puts no settle marker", () => {
    const v = view("auctioning");
    expect(tile(v, "Implied value").sub).toBe("live clearing × 16");
    expect(v.price.marks.map((m) => m.label)).not.toContain("S");
    expect(v.price.settledAt).toBeUndefined();
  });

  it("shows the latest sharding's history after a buyout, implied n/a", () => {
    const v = view("whole-after-buyout");
    expect(tile(v, "Implied value")).toMatchObject({ value: "n/a", sub: "bought out at $1,712.00/shard" });
    expect(v.price.marks.map((m) => m.label)).toEqual(expect.arrayContaining(["S", "B", "A"]));
    expect(v.fees).toMatchObject({ sale: 128_400_000n, buyout: 128_400_000n, total: 256_800_000n });
  });

  it("degrades to the quote, or a clear note, without market history", () => {
    const priced = view("sharded");
    expect(priced.price.market).toBe(1562.5);
    const unpriced = view("sharded", { price: null });
    expect(unpriced.price.market).toBeNull();
    expect(tile(unpriced, "Premium")).toMatchObject({ value: "n/a", sub: "no market price" });
    // A live auction with no bids has no clearing, so no premium either.
    expect(tile(view("auctioning", { checkpoints: [] }), "Premium")).toMatchObject({ value: "n/a", sub: "no clearing yet" });
  });

  it("gives an unclaimed winning bidder their own 'to claim' ownership slice", () => {
    const names = view("settled-unclaimed").ownership.slices.map((sl) => [sl.name, sl.value]);
    expect(names).toContainEqual([expect.stringMatching(/ · to claim$/), 0.125]);
    expect(names.map(([n]) => n)).not.toContain("Unclaimed in auction");
  });

  it("keeps a premium that prints as 0% neutral, not green or red", () => {
    const implied = Number(String(tile(view("auctioning"), "Implied value").value).replace(/[$,]/g, ""));
    const base = cardFixture("auctioning", NOW).price!;
    // 0.3% under the implied value: below the 0.5% neutral threshold.
    const v = view("auctioning", { price: { ...base, adjustedUsd: (implied / 1.003).toFixed(2) } });
    expect(tile(v, "Premium")).toMatchObject({ value: "0%", tone: "default" });
  });

  it("shows skeletons, not empty states, while bids, checkpoints and fees load", () => {
    renderAnalytics({ ...cardFixture("sharded", NOW), bids: [], checkpoints: [], fees: [], bidsLoading: true, checkpointsLoading: true, feesLoading: true });
    expect(screen.queryByText("No bids yet")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByLabelText("Fees to the vault")).toBeNull();
    expect(document.querySelector("[data-slot=kpi-strip]")).toBeNull();
  });

  it("drops the Market legend without a market price", () => {
    renderAnalytics({ ...cardFixture("sharded", NOW), price: null });
    expect(within(screen.getByRole("region", { name: "Price per shard" })).queryByText("Market")).toBeNull();
  });

  it("has one empty panel for a card never sharded", () => {
    renderAnalytics(cardFixture("whole", NOW));
    expect(screen.getByText("No analytics yet. This card hasn't been sharded.")).toBeTruthy();
    expect(document.querySelector("[data-slot=kpi-strip]")).toBeNull();
  });

  it("charts the pool price after the settle from the swaps, and none without a pool", () => {
    const base = cardFixture("sharded", NOW);
    const s = base.sharding!;
    const settle = base.activities.find((x) => x.kind === "settle")!;
    const pool = { cardId: 1n, poolId: "0x01", shardToken: s.shardToken, shardIsCurrency0: true, sqrtPriceX96: 0n, priceUsdcPerShard: 1_900_000_000n, seededAt: BigInt(settle.timestamp),
      seedShards: 8n * S, seedUsdc: 1n, lastSwapAt: null, swapCount: 2, volumeUsdc: 0n, frozen: false, lpOwner: PAOLO, feesShards: 0n, feesUsdc: 0n } as NonNullable<CardData["pool"]>;
    const swap = (id: string, dt: number, price: bigint) => ({ id, cardId: 1n, trader: KENJI, side: "buy", shardAmount: S, usdcAmount: price, priceUsdcPerShard: price, sqrtPriceX96: 0n,
      blockNumber: BigInt(settle.timestamp + dt), timestamp: BigInt(settle.timestamp + dt), txHash: "0x" }) as NonNullable<CardData["swaps"]>[number];
    const v = view("sharded", { pool, swaps: [swap("b", 120, 1_900_000_000n), swap("a", 60, 1_800_000_000n)] });
    const after = v.price.points.filter((p) => p.t >= settle.timestamp);
    expect(after[0]!.pool).toBe(1712); // opened at the clearing
    expect(after.map((p) => p.pool)).toContain(1800);
    expect(after.at(-1)!.pool).toBe(1900);
    expect(view("sharded").price.points.every((p) => p.pool === undefined)).toBe(true);
  });

  it("buckets long series to the last value of each bucket", () => {
    expect(lastPerBucket([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toEqual([2, 4, 6, 8, 10]);
    expect(lastPerBucket([1, 2], 5)).toEqual([1, 2]);
  });
});
