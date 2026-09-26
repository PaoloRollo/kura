// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AnalyticsDashboard } from "@/components/analytics-dashboard";
import { DailyBars } from "@/components/charts/daily-bars";
import type { AnalyticsView } from "@/lib/analytics-view";

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
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByText("Hour (UTC)")).toBeTruthy();
    expect(screen.getByText("2026-09-26 14:00")).toBeTruthy();
  });
});
