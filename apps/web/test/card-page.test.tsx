// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
vi.mock("@ponder/react", () => ({ usePonderQuery: () => ({ data: undefined, isSuccess: false }), usePonderStatus: () => ({ data: undefined }) }));
// The auction panel sends through Privy and reads the chain; neither is reached here.
vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ address: null, identityToken: null, login: vi.fn(), logout: vi.fn() }), apiFetch: vi.fn() }));
vi.mock("@/lib/tx", async () => ({ ...(await vi.importActual<object>("@/lib/tx-core")), useSendTx: () => ({ send: vi.fn(), walletKind: "embedded" }), getReceipt: async () => null }));
vi.mock("@/lib/chain", async (orig) => ({ ...(await orig<object>()), publicClient: { readContract: () => new Promise(() => {}) } }));
vi.mock("@/components/world-id-gate", () => ({ WorldIdGate: () => <button type="button">Verify with World ID</button>, worldIdErrorMessage: (c: string) => c, worldIdRefusalTitle: () => "Refused" }));
Object.defineProperty(window, "matchMedia", { value: (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }) });

import { CardPageView } from "@/components/card-page-view";
import { CardNotFound } from "@/components/card-page-parts";
import { ACTIVITY_LIMIT } from "@/hooks/use-card";
import { HandlesFixture } from "@/hooks/use-handles";
import type { CardTab } from "@/lib/card-view";
import { FIXTURE_HEAD, HANDLES, KENJI, PAOLO, cardFixture, type PreviewState } from "@/app/design/card/fixtures";

afterEach(cleanup);

const NOW = 1_790_000_000;
function renderCard(state: PreviewState, opts: { me?: string | null; tab?: CardTab } = {}) {
  const c = cardFixture(state, NOW);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <HandlesFixture.Provider value={HANDLES}>
        <CardPageView c={c} me={opts.me === undefined ? PAOLO : opts.me} now={NOW} block={FIXTURE_HEAD} tab={opts.tab ?? "overview"} tabHref={(t) => `/app/cards/1?tab=${t}`} />
      </HandlesFixture.Provider>
    </QueryClientProvider>,
  );
}

describe("CardPageView", () => {
  it("offers the owner of a whole card to shard it or collect it at the counter, with the priced market", () => {
    renderCard("whole-owner");
    expect(screen.getByRole("link", { name: /Shard this card/ }).getAttribute("href")).toBe("/app/cards/1/shard");
    expect(screen.getByRole("button", { name: /Collect at the counter/ })).toBeTruthy();
    expect(screen.getByText("You own")).toBeTruthy();
    expect(screen.getByText("$25,000")).toBeTruthy();
    expect(screen.getByText("Scryfall USD · nonfoil · EN printing · NM ×1.00")).toBeTruthy();
  });

  it("shows anyone else who owns a whole card, with no CTA", () => {
    renderCard("whole");
    expect(screen.getByText("Owned by")).toBeTruthy();
    expect(screen.getAllByText("kenji.kura.eth").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Shard this card/)).toBeNull();
  });

  it("gates the shard CTA on ownerOf, not only on being signed in", () => {
    renderCard("whole-owner", { me: KENJI });
    expect(screen.queryByText(/Shard this card/)).toBeNull();
    renderCard("whole-owner", { me: null });
    expect(screen.queryAllByText(/Shard this card/)).toHaveLength(0);
  });

  it("puts the tab strip on every view, with the active tab marked", () => {
    renderCard("auctioning");
    const nav = screen.getByRole("navigation", { name: "Card sections" });
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Holders" }).getAttribute("href")).toBe("/app/cards/1?tab=holders");
  });

  it("shows the live auction context and the on-chain profile with key roles", () => {
    renderCard("auctioning");
    expect(screen.getByText("Live auction")).toBeTruthy();
    expect(screen.getByText("LEA · Rare")).toBeTruthy();
    expect(screen.getByText(/sharded by/)).toBeTruthy();
    const profile = screen.getAllByRole("region", { name: "On-chain profile" })[0]!;
    expect(within(profile).getByText("ENSv2 · Sepolia")).toBeTruthy();
    expect(within(profile).getByText("appraiser")).toBeTruthy();
    expect(within(profile).getByText("vendor")).toBeTruthy();
    expect(screen.getAllByText(/Illustrated by Christopher Rush/).length).toBeGreaterThan(0);
  });

  it("puts the bid form behind World ID on a live auction", () => {
    renderCard("auctioning");
    expect(screen.getByText("Clearing price, per block")).toBeTruthy();
    expect(screen.getByText("Prove you're a unique human")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Verify to place a bid/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Spend up to")).toBeTruthy();
    // aD9is: no field hints or steps footer until verified.
    expect(screen.queryByText(/The total you commit/)).toBeNull();
    expect(screen.queryByText(/3 steps/)).toBeNull();
  });

  it("marks a released card's profile as revoked read-only history", () => {
    renderCard("released");
    expect(screen.getByText(/name revoked on release/)).toBeTruthy();
    expect(screen.getAllByText("revoked · read-only history").length).toBeGreaterThan(0);
    expect(screen.getByText("This card left the vault")).toBeTruthy();
    expect(screen.getByText("Final buyout")).toBeTruthy();
    expect(screen.getByText("Paid to holders")).toBeTruthy();
  });

  it("shows a released card that was never bought out without buyout tiles", () => {
    renderCard("released-no-buyout");
    expect(screen.getByText("This card left the vault")).toBeTruthy();
    expect(screen.queryByText("Final buyout")).toBeNull();
    expect(screen.queryByText("Paid to holders")).toBeNull();
    expect(screen.getByText("Release tx")).toBeTruthy();
    expect(screen.queryByText(/haven't claimed their payout/)).toBeNull();
  });

  it("lists holders without the auction or vault, with the unclaimed tile", () => {
    renderCard("auctioning", { tab: "holders" });
    expect(screen.getByText("1 wallet")).toBeTruthy();
    expect(screen.getByText("3.0 shards")).toBeTruthy();
    expect(screen.getByText("can redeem")).toBeTruthy();
    expect(screen.getByText("black-lotus-lea-1.kura.eth · auctioning · 16 shards")).toBeTruthy();
  });

  it("shows a whole card's holders as one owner", () => {
    renderCard("whole", { tab: "holders" });
    expect(screen.getByText("Not sharded, one owner")).toBeTruthy();
  });

  it("paginates the activity feed and filters it", () => {
    renderCard("sharded", { tab: "activity" });
    expect(screen.getByText("Showing 1–10 of 20 events")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(screen.getByText("Showing 11–20 of 20 events")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "25" } });
    expect(screen.getByText("Showing 1–20 of 20 events")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bids" }));
    expect(screen.getByRole("button", { name: "Bids" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Showing 1–6 of 6 events")).toBeTruthy();
    expect(screen.queryByText("Minted")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Transfers" }));
    expect(screen.getByText("0.5 shards")).toBeTruthy();
  });

  it("shows the latest six events on the Overview", () => {
    renderCard("sharded");
    expect(screen.getAllByRole("listitem").filter((li) => li.textContent?.match(/(Bid|Claimed|Exited|Settled|Transfer|ENS record) ·/)).length).toBe(6);
  });

  it("says 500+ when the activity query hit its limit", () => {
    const c = cardFixture("sharded", NOW);
    const many = Array.from({ length: ACTIVITY_LIMIT }, (_, i) => ({ ...c.activities[0]!, id: `0x${i}-0`, logIndex: i }));
    render(
      <HandlesFixture.Provider value={HANDLES}>
        <CardPageView c={{ ...c, activities: many, transfers: [], ensRecords: [] }} me={PAOLO} now={NOW} block={FIXTURE_HEAD} tab="activity" tabHref={(t) => `?tab=${t}`} />
      </HandlesFixture.Provider>,
    );
    expect(screen.getByText("Showing 1–10 of 500+ events")).toBeTruthy();
  });

  it("explains an empty activity feed", () => {
    renderCard("empty", { tab: "activity" });
    expect(screen.getByText("No activity yet")).toBeTruthy();
    expect(screen.getByText("Showing 0–0 of 0 events")).toBeTruthy();
  });

  it("shows a card that is whole again after a buyout as one owner, with no redemption meter", () => {
    renderCard("whole-after-buyout");
    expect(screen.getByText("Whole")).toBeTruthy();
    expect(screen.getByText("one owner")).toBeTruthy();
    expect(screen.queryByText("Distance to redemption")).toBeNull();
    expect(screen.queryByText(/1\.5 · 9\.4%/)).toBeNull();
    expect(screen.getByRole("link", { name: /Shard this card/ })).toBeTruthy();
  });

  it("says a bought-out card's Holders are one owner and links the buyout to the activity", () => {
    renderCard("whole-after-buyout", { tab: "holders" });
    expect(screen.getByText("Whole, one owner")).toBeTruthy();
    const link = screen.getByRole("link", { name: /^Bought out on .+ · minority holders claim payouts$/ });
    expect(link.getAttribute("href")).toBe("/app/cards/1?tab=activity");
    expect(screen.queryByText("can redeem")).toBeNull();
  });

  it("shows the bought-out sharding's auction as history", () => {
    renderCard("whole-after-buyout", { tab: "auction" });
    expect(screen.getByText("Past auction · history")).toBeTruthy();
    expect(screen.getByText("per shard · paid $5,136")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open the auction" })).toBeNull();
  });

  it("has a mobile Nav row with a way back to the app on every view", () => {
    renderCard("whole-owner");
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/app");
    cleanup();
    renderCard("sharded", { tab: "holders" });
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/app");
  });

  it("says when a card does not exist", () => {
    render(<CardNotFound id="999" />);
    expect(screen.getByText("Card not found")).toBeTruthy();
  });
});
