// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChartFrame } from "@/components/charts/chart-frame";
import { DemandBars, demandRows } from "@/components/charts/demand-bars";
import { KpiStrip } from "@/components/charts/kpi-strip";
import { Leaderboard } from "@/components/charts/leaderboard";
import { squarify } from "@/components/charts/market-treemap";
import { ownershipRows } from "@/components/charts/ownership-bar";
import { priceDomain, priceScale } from "@/components/charts/price-bars";
import { premiumFill, premiumLabel, premiumTone, usdCompact } from "@/lib/chart-colors";

afterEach(cleanup);

const table = { columns: ["Time", "Clearing $"], rows: [["14:02", "$1,560"], ["14:22", "$1,712"]] };

describe("ChartFrame", () => {
  it("toggles the plot for a table with the given rows", () => {
    render(<ChartFrame title="Price per shard" table={table}><div data-testid="plot" /></ChartFrame>);
    expect(screen.getByTestId("plot")).toBeTruthy();
    const chip = screen.getByRole("button", { name: "Table" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.textContent).toBe("Table");
    expect(screen.queryByTestId("plot")).toBeNull();
    const t = screen.getByRole("table");
    const rows = within(t).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[2]!).getByText("$1,712")).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.getByTestId("plot")).toBeTruthy();
  });

  it("shows the legend only with two or more entries", () => {
    const { rerender } = render(<ChartFrame title="A" table={table} legend={[{ label: "Clearing", color: "var(--kura-s1)" }]}>x</ChartFrame>);
    expect(screen.queryByRole("list", { name: "Legend" })).toBeNull();
    rerender(
      <ChartFrame title="A" table={table} legend={[{ label: "Clearing", color: "var(--kura-s1)" }, { label: "Market", color: "var(--kura-s2)" }]}>x</ChartFrame>,
    );
    expect(within(screen.getByRole("list", { name: "Legend" })).getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("DemandBars", () => {
  const points = [
    { price: 1700, cumulative: 8500 },
    { price: 1800, cumulative: 1800 },
    { price: 1712, cumulative: 6848 },
  ];

  it("lists levels highest first and marks the clearing row in s2", () => {
    const { container } = render(<DemandBars points={points} clearing={1712} forSale={3} />);
    const rows = container.querySelectorAll("li");
    expect([...rows].map((r) => r.firstElementChild?.textContent)).toEqual(["$1,800", "$1,712", "$1,700"]);
    const clearing = container.querySelector("li[data-clearing]")!;
    expect(clearing.firstElementChild?.className).toContain("text-s2");
    expect(clearing.querySelector(".bg-s2")).toBeTruthy();
    expect(container.querySelectorAll(".bg-s2")).toHaveLength(1);
    expect(screen.getByText("Clears at $1,712 where demand covers the 3 shards for sale.")).toBeTruthy();
  });

  it("windows long curves around the clearing level", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ price: 1000 + i * 10, cumulative: (20 - i) * 100 }));
    const rows = demandRows(many, 1050);
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.price)).toContain(1050);
    expect(rows[0]!.price).toBeGreaterThan(rows[7]!.price);
  });
});

describe("chart colours", () => {
  it("fills a +25% premium at full strength and a missing one neutral", () => {
    expect(premiumFill(0.25)).toBe("color-mix(in srgb, var(--kura-s1) 55%, var(--kura-surface-2))");
    expect(premiumFill(0.6)).toBe(premiumFill(0.25));
    expect(premiumFill(-0.25)).toBe("color-mix(in srgb, var(--kura-s2) 55%, var(--kura-surface-2))");
    expect(premiumFill(0.125)).toBe("color-mix(in srgb, var(--kura-s1) 27.5%, var(--kura-surface-2))");
    expect(premiumFill(null)).toBe("var(--kura-surface-2)");
    expect(premiumFill(0.004)).toBe("var(--kura-surface-2)");
  });

  it("labels and tones premiums the way the designs print them", () => {
    expect(premiumLabel(0.096)).toBe("+9.6%");
    expect(premiumLabel(-0.185)).toBe("-18.5%");
    expect(premiumLabel(0)).toBe("0%");
    expect(premiumLabel(null)).toBe("n/a");
    expect(premiumTone(0.1)).toBe("text-s1-fg");
    expect(premiumTone(-0.1)).toBe("text-s2-fg");
    expect(premiumTone(null)).toBe("text-muted-foreground");
    expect(usdCompact(21300)).toBe("$21.3k");
    expect(usdCompact(27000)).toBe("$27k");
  });
});

describe("layouts", () => {
  it("squarifies areas proportional to value inside the rect", () => {
    const values = [6, 6, 4, 3, 2, 2, 1];
    const rects = squarify(values, { x: 0, y: 0, w: 600, h: 400 });
    const total = values.reduce((a, b) => a + b, 0);
    rects.forEach((r, i) => {
      expect(r.w * r.h).toBeCloseTo((values[i]! / total) * 600 * 400, 6);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(600 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(400 + 1e-9);
    });
  });

  it("groups holders past the top four into Other", () => {
    const rows = ownershipRows(["a", "b", "c", "d", "e", "f"].map((id, i) => ({ id, name: id, label: id, value: 6 - i })));
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d", "other"]);
    expect(rows.at(-1)!.value).toBe(3);
    expect(rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1);
  });

  it("keeps the price floor below the lowest bar", () => {
    const [lo, hi] = priceDomain([1560, 1712]);
    expect(lo).toBeLessThan(1560);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeGreaterThan(1712);
  });

  it("labels the truncated floor: the lowest tick is the domain floor, ticks on nice steps", () => {
    for (const values of [[1560, 1712], [1560, 1560, 1572, 1705, 1712], [0.42, 0.61], [12, 12], [1600, 1650, 1700]]) {
      const { domain, ticks } = priceScale(values);
      expect(ticks[0]).toBe(domain[0]);
      expect(ticks[2]).toBe(domain[1]);
      expect(ticks[1] - ticks[0]).toBeCloseTo(ticks[2] - ticks[1], 9);
      expect(domain[0]).toBeLessThanOrEqual(Math.min(...values));
      expect(domain[1]).toBeGreaterThanOrEqual(Math.max(...values));
    }
    expect(priceScale([1560, 1712])).toEqual({ domain: [1400, 1800], ticks: [1400, 1600, 1800] });
  });

  it("formats chart times in UTC", async () => {
    const { hhmm } = await import("@/lib/chart-colors");
    expect(hhmm(Date.UTC(2026, 8, 24, 14, 2) / 1000)).toBe("14:02");
  });

  it("tones KPI values", () => {
    const { container } = render(<KpiStrip items={[{ label: "Premium", value: "+9.6%", tone: "pos" }, { label: "To redemption", value: "eligible", tone: "kin" }]} />);
    expect(screen.getByText("+9.6%").className).toContain("text-s1-fg");
    expect(screen.getByText("eligible").className).toContain("text-kin");
    expect(container.querySelectorAll("[data-slot=stat-tile]")).toHaveLength(2);
  });
});

describe("Leaderboard", () => {
  it("marks a live auction's premium, in the list and the table", () => {
    render(<Leaderboard title="Richest premiums" rows={[{ rank: 1, label: "Black Lotus", value: "+9.6%", tone: "pos" }, { rank: 2, label: "Mox Pearl", value: "+3.1%", tone: "pos", live: true }]} />);
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]!).queryByText("live")).toBeNull();
    expect(within(items[1]!).getByText("live")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByText("+3.1% (live)")).toBeTruthy();
    expect(screen.getByText("+9.6%")).toBeTruthy();
  });
});
