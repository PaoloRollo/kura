// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuctionCard, Button, EnsName, FilterChip, Pill, RedemptionMeter, StatTile } from "@/components/kura";

afterEach(cleanup);

describe("Kura components", () => {
  it("renders the Kura button variants through the shadcn Button", () => {
    render(<Button variant="redeem" size="md">Redeem</Button>);
    const b = screen.getByRole("button", { name: "Redeem" });
    expect(b.dataset.variant).toBe("redeem");
    expect(b.className).toContain("bg-kin");
  });

  it("labels pills by tone", () => {
    render(<><Pill tone="live" /><Pill tone="released" /></>);
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Released").closest("[data-tone]")?.getAttribute("data-tone")).toBe("released");
  });

  it("marks the redemption meter eligible at the 80% threshold", () => {
    const { rerender } = render(<RedemptionMeter value={0.813} />);
    expect(screen.getByText("81.3% · eligible")).toBeTruthy();
    rerender(<RedemptionMeter value={0.469} />);
    expect(screen.getByText("46.9% · needs 80%")).toBeTruthy();
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("46.9");
  });

  it("copies the ENS name to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<EnsName name="paolo.kura.eth" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy paolo.kura.eth" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith("paolo.kura.eth");
  });

  it("renders an auction card from props", () => {
    render(
      <AuctionCard image="/cards/black-lotus.webp" name="Black Lotus" set="LEA · NM" clearingPrice="$1,712" premium={9.6} timeLeft="04:12" progress={0.62} />,
    );
    expect(screen.getByRole("img", { name: "Black Lotus" })).toBeTruthy();
    expect(screen.getByText("+9.6%")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("62");
  });

  it("renders stat tiles and filter chips", () => {
    render(<><StatTile label="Clearing price" value="$1,712" sub="per shard" /><FilterChip label="Condition" value="NM" active /></>);
    expect(screen.getByText("$1,712")).toBeTruthy();
    expect(screen.getByRole("button").dataset.active).toBe("true");
  });
});
