// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AnalyticsDashboard } from "@/components/analytics-dashboard";
import { DailyBars } from "@/components/charts/daily-bars";
import type { AnalyticsView } from "@/lib/analytics-view";
import type { RecentPanel } from "@/components/multibaas-recent";
import { recentFromRows } from "@/lib/multibaas/recent";

vi.mock("@ponder/react", () => ({ usePonderQuery: () => ({ data: undefined, isSuccess: false }), usePonderStatus: () => ({ data: { sepolia: { block: { number: 1000, timestamp: Math.floor(Date.now() / 1000) } } } }) }));

class RO {
  observe() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;

afterEach(cleanup);

const view = (over: Partial<AnalyticsView> = {}): AnalyticsView => ({
  window: { from: 0, to: 0, unit: "day" },
  tiles: { cardsInVault: 23, mintedInRange: 4, valueLocked: 412_860_000_000n, raised: 96_420_000_000n, raisedAuctions: 11, fees: 2_410_000_000n, liveAuctions: 3, nextEndsIn: 21n, nextEndBlock: 1_021n, collectors: 58 },
  treemap: [{ id: "1", name: "Black Lotus", value: 27_392, premium: 0.096, href: "/app/cards/1?tab=analytics" }],
  premiums: [{ rank: 1, label: "Time Walk", value: "+14.8%", tone: "pos", href: "/app/cards/4?tab=analytics" }],
  languages: [{ label: "English", count: 15 }],
  volume: ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"].map((date, i) => ({ date, value: i * 1000 })),
  empty: false,
  source: "indexer",
  ...over,
});

describe("Analytics dashboard (Y1eNn)", () => {
  it("shows the six tiles with the design's copy and the live fee", () => {
    render(<AnalyticsDashboard view={view()} isLoading={false} feeBps={250} range="7d" onRange={() => {}} />);
    expect(screen.getByRole("heading", { name: "The vault, live" })).toBeTruthy();
    for (const text of ["$412,860.00", "$96,420.00", "$2,410.00", "+4 this week", "across 11 auctions", "2.5% of sales + buyouts", "World ID, one per human"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    // 21 blocks at 12 s from the indexer head, ticking from there.
    expect(screen.getByText((_, el) => el?.tagName === "SPAN" && /^next ends in 04:1[12]$/.test(el.textContent ?? ""))).toBeTruthy();
    expect(screen.getByRole("link", { name: /Time Walk/ }).getAttribute("href")).toBe("/app/cards/4?tab=analytics");
  });

  it("switches the range through the segmented control", () => {
    const onRange = vi.fn();
    render(<AnalyticsDashboard view={view()} isLoading={false} feeBps={250} range="7d" onRange={onRange} />);
    const group = screen.getByRole("radiogroup", { name: "Time range" });
    expect(within(group).getByRole("radio", { name: "7d" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "24h" }));
    expect(onRange).toHaveBeenCalledWith("24h");
  });

  it("says the vault is empty in each panel, with $0 tiles", () => {
    const zero = { cardsInVault: 0, mintedInRange: 0, valueLocked: 0n, raised: 0n, raisedAuctions: 0, fees: 0n, liveAuctions: 0, nextEndsIn: null, nextEndBlock: null, collectors: 0 };
    render(<AnalyticsDashboard view={view({ empty: true, tiles: zero, treemap: [], premiums: [], languages: [] })} isLoading={false} feeBps={null} range="7d" onRange={() => {}} />);
    expect(screen.getAllByText("Nothing in the vault yet.")).toHaveLength(4);
    expect(screen.getAllByText("$0.00").length).toBe(3);
    expect(screen.getByText("none running")).toBeTruthy();
  });

  it("shows the sync state while loading", () => {
    render(<AnalyticsDashboard view={null} isLoading feeBps={null} range="7d" onRange={() => {}} />);
    expect(screen.getByText(/Loading the vault's analytics/)).toBeTruthy();
  });

  it("labels hourly buckets in UTC and keeps the latest label", () => {
    const points = Array.from({ length: 24 }, (_, i) => ({ date: `2026-09-${i < 9 ? 25 : 26}T${String((15 + i) % 24).padStart(2, "0")}`, value: 0 }));
    render(<DailyBars points={points} label="Volume, USDC" unit="hour" />);
    expect(screen.getAllByText("14:00").length).toBeGreaterThan(0);
    expect(screen.queryByText("Sat")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show table" }));
    expect(screen.getByText("Hour (UTC)")).toBeTruthy();
    expect(screen.getByText("2026-09-26 14:00")).toBeTruthy();
  });

  it("says where the aggregates came from, per range", () => {
    const { rerender } = render(<AnalyticsDashboard view={view({ source: "multibaas" })} isLoading={false} feeBps={250} range="24h" onRange={() => {}} />);
    expect(screen.getByText("Data: MultiBaas").getAttribute("title")).toMatch(/MultiBaas Event Queries/);
    rerender(<AnalyticsDashboard view={view()} isLoading={false} feeBps={250} range="24h" onRange={() => {}} />);
    expect(screen.getByText("Data: indexer").getAttribute("title")).toMatch(/unavailable or not configured.*Ponder indexer/);
    rerender(<AnalyticsDashboard view={view()} isLoading={false} feeBps={250} range="7d" onRange={() => {}} />);
    expect(screen.getByText("Data: indexer").getAttribute("title")).toMatch(/7d and All come from the Ponder indexer/);
    expect(screen.queryByText(/24h via MultiBaas/)).toBeNull(); // MultiBaas unavailable: not claimed
    expect(screen.queryByRole("region", { name: /Recent vault events/ })).toBeNull();
  });

  const now = Date.UTC(2026, 8, 26, 11, 30) / 1000;
  const since = Date.UTC(2026, 8, 26, 9, 2) / 1000;
  const panel = (rows: Partial<Parameters<typeof recentFromRows>[0]> = {}): RecentPanel => ({
    recent: recentFromRows({ settles: [], redeems: [], mints: [], fees: [], ...rows }, { startBlock: 11_785_122, since, fromDeploy: false }),
    names: new Map([["1", "Black Lotus"]]),
    now,
  });

  it("shows MultiBaas's recent events newest first, with since when it indexes the vault", () => {
    const tx = `0x${"ab".repeat(32)}`;
    render(<AnalyticsDashboard view={view()} isLoading={false} feeBps={250} range="7d" onRange={() => {}} recent={panel({
      settles: [{ at: new Date((now - 3600) * 1000).toISOString(), block: 11_785_500, tx, card: "1", raised: "3400000000", graduated: true }],
      fees: [{ at: new Date((now - 3600) * 1000).toISOString(), block: 11_785_500, tx, card: "1", kind: "0", amount: "85000000" }],
      mints: [{ at: new Date((now - 7200) * 1000).toISOString(), block: 11_785_200, tx: "0x1", card: "9" }],
    })} />);
    const region = screen.getByRole("region", { name: "Recent vault events · via MultiBaas" });
    const items = within(region).getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toMatch(/^Fee to vault ·\s?Black Lotus\$85\.00 · sale/);
    expect(items[1]).toMatch(/^Auction settled ·\s?Black Lotus\$3,400\.00 raised.*1h$/);
    expect(items[2]).toMatch(/^Minted ·\s?Card #9card #9.*2h$/);
    expect(within(region).getByText(/Indexed by MultiBaas since Sep 26, 09:02 UTC · 3 events held/)).toBeTruthy();
    expect(within(region).getAllByRole("link", { name: /0xaba…bab/ })[0]!.getAttribute("href")).toBe(`https://sepolia.etherscan.io/tx/${tx}`);
    // Recent answers, but the 24h figures don't yet (the first day): no claim that 24h reads MultiBaas, only when it will.
    expect(screen.queryByText("24h via MultiBaas")).toBeNull();
    expect(screen.getByText("24h via MultiBaas from Sep 27, 09:00 UTC")).toBeTruthy();
  });

  it("claims 24h via MultiBaas on 7d and All only while the 24h figures really come from it", () => {
    const late = { ...panel(), now: Date.UTC(2026, 8, 27, 12, 0) / 1000 }; // past the takeover time
    const { rerender } = render(<AnalyticsDashboard view={view()} isLoading={false} feeBps={250} range="7d" onRange={() => {}} recent={late} />);
    expect(screen.queryByText(/24h via MultiBaas/)).toBeNull();
    rerender(<AnalyticsDashboard view={view()} isLoading={false} feeBps={250} range="all" onRange={() => {}} recent={late} multibaas24h />);
    expect(screen.getByText("24h via MultiBaas")).toBeTruthy();
    rerender(<AnalyticsDashboard view={view()} isLoading={false} feeBps={250} range="7d" onRange={() => {}} multibaas24h />);
    expect(screen.getByText("24h via MultiBaas")).toBeTruthy();
    // 24h past the takeover, MultiBaas reachable but the figures still refused: catching up, not "unavailable".
    rerender(<AnalyticsDashboard view={view()} isLoading={false} feeBps={250} range="24h" onRange={() => {}} recent={late} />);
    expect(screen.getByText("Data: indexer").getAttribute("title")).toMatch(/catching up/);
    expect(screen.queryByText(/MultiBaas from/)).toBeNull();
  });

  it("says MultiBaas holds nothing yet, and when it takes over the 24h figures", () => {
    render(<AnalyticsDashboard view={view()} isLoading={false} feeBps={250} range="24h" onRange={() => {}} recent={panel()} />);
    const region = screen.getByRole("region", { name: "Recent vault events · via MultiBaas" });
    expect(within(region).getByText("No vault events indexed by MultiBaas yet · since Sep 26, 09:02 UTC")).toBeTruthy();
    expect(within(region).queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("MultiBaas from Sep 27, 09:00 UTC")).toBeTruthy();
    expect(screen.getByText("Data: indexer").getAttribute("title")).toMatch(/once it has indexed a full day \(from Sep 27, 09:00 UTC\)/);
  });
});
