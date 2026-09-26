// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ address: null, identityToken: null, login: vi.fn(), logout: vi.fn() }), apiFetch: vi.fn() }));
vi.mock("@/lib/tx", async () => ({ ...(await vi.importActual<object>("@/lib/tx-core")), useSendTx: () => ({ send: vi.fn(), walletKind: "embedded" }), getReceipt: async () => null }));
vi.mock("@/components/world-id-gate", () => ({ WorldIdGate: () => <button type="button">Verify with World ID</button>, worldIdErrorMessage: (c: string) => c, worldIdRefusalTitle: () => "Refused" }));
Object.defineProperty(window, "matchMedia", { value: (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }) });

import { usdcPerShardToQ96 } from "@kura/shared";
import { AuctionIoContext } from "@/components/auction-io";
import { AuctionPanel } from "@/components/auction-panel";
import type { BidRow, CardData } from "@/hooks/use-card";
import { PAOLO, cardFixture } from "@/app/design/card/fixtures";

afterEach(cleanup);
const usd = (d: number) => BigInt(Math.round(d * 100)) * 10_000n;

function ended(opts: { settled: boolean; graduated: boolean; mine: Array<[bigint, number, number, BidRow["status"], bigint | null]> }): CardData {
  const c = cardFixture("auctioning", 1_790_000_000);
  const s = c.sharding!;
  const mine = opts.mine.map(([bidId, amount, max, status, filled]): BidRow => ({
    id: `${s.auction}-${bidId}`, auction: s.auction, bidId, cardId: 1n, shardToken: s.shardToken, owner: PAOLO, maxPriceQ96: usdcPerShardToQ96(usd(max)), amountUsdc: usd(amount),
    submittedBlock: s.startBlock + 1n, submittedAt: 0, status, tokensFilled: filled, currencyRefunded: filled == null ? null : usd(amount), updatedBlock: s.endBlock, updatedAt: 0,
  }));
  return {
    ...c,
    card: { ...c.card!, state: opts.settled ? "sharded" : "auctioning" },
    sharding: { ...s, settled: opts.settled, graduated: opts.settled ? opts.graduated : null, raisedUsdc: opts.settled && opts.graduated ? usd(5136) : opts.settled ? 0n : null },
    bids: mine,
  };
}

function renderPanel(c: CardData, graduated: boolean) {
  const read = async (req: { functionName: string }) => ({ clearingPrice: usdcPerShardToQ96(usd(1712)), currencyRaised: graduated ? usd(5136) : usd(1240), totalCleared: graduated ? 3n * 10n ** 18n : 0n, isGraduated: graduated, balanceOf: 0n })[req.functionName] as never;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AuctionIoContext.Provider value={{ read }}>
        <AuctionPanel c={c} me={PAOLO} block={c.sharding!.endBlock + 1n} />
      </AuctionIoContext.Provider>
    </QueryClientProvider>,
  );
}

describe("AuctionPanel after the end block", () => {
  it("shows a neutral outcome with a plain Settle before the auction is settled", async () => {
    renderPanel(ended({ settled: false, graduated: true, mine: [[4n, 2000, 1760, "open", null]] }), true);
    expect(screen.getByText("Auction ended · settle to finalize the outcome")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/\$5,136\.00 raised so far/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /^Settle$/ })).toBeTruthy();
    expect(screen.queryByText("Auction graduated")).toBeNull();
    expect(screen.queryByText(/Cleared at/)).toBeNull();
    expect(screen.queryByText(/vault fee/)).toBeNull();
    expect(screen.getByText(/Exits open once the auction is settled/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Claim shards/ })).toBeNull();
  });

  it("does not call the reserve missed until the settled row says so", async () => {
    renderPanel(ended({ settled: false, graduated: false, mine: [[4n, 2000, 1760, "open", null]] }), false);
    await waitFor(() => expect(screen.getByText(/\$1,240\.00 raised so far/)).toBeTruthy());
    expect(screen.queryByText("Reserve not met")).toBeNull();
    expect(screen.queryByRole("button", { name: /Settle and refund/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Settle$/ })).toBeTruthy();
  });

  it("reads the graduated outcome and shards sold from the settled auction", async () => {
    renderPanel(ended({ settled: true, graduated: true, mine: [] }), true);
    expect(screen.getByText("Auction graduated")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("3 of 3 shards sold · $5,136.00 raised")).toBeTruthy());
  });

  it("shows exit then claim for a filled bid and treats a zero-fill exit as final", () => {
    renderPanel(ended({ settled: true, graduated: true, mine: [[4n, 2000, 1760, "open", null], [5n, 1640, 1640, "exited", 0n]] }), true);
    expect(screen.getByRole("button", { name: "1 · Exit bid" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2 · Claim shards" })).toBeTruthy();
    expect(screen.getByText("Refund received")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Claim shards/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Settle/ })).toBeNull();
  });

  it("offers Take back once the settled row says the reserve was not met", async () => {
    renderPanel(ended({ settled: true, graduated: false, mine: [[4n, 2000, 1760, "open", null]] }), false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Take back $2,000.00" })).toBeTruthy());
    expect(screen.getByText("refund due")).toBeTruthy();
    expect(screen.getByText("Reserve not met")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Raised $1,240.00 of $4,680.00")).toBeTruthy());
  });

  it("says when I have no bids", () => {
    renderPanel(ended({ settled: true, graduated: true, mine: [] }), true);
    expect(screen.getByText("You have no bids on this auction.")).toBeTruthy();
  });
});
