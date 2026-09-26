// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TxProgress, describeTxError } from "@/components/tx-stepper";

afterEach(cleanup);

const HASH = "0x5d1e3f5a7c9e1b3d5f7092a4c6e8b0d2f4a6c8e0b1d3f5a7c9e1b3d5f709207b";
const rows = [{ id: "a", label: "Bid", status: "failed" as const }];

describe("TxProgress error card", () => {
  it("shows the mono line with the hash even without a decoded error name", () => {
    const { container } = render(<TxProgress title="t" rows={rows} failure={{ title: "Reverted", hash: HASH }} />);
    expect(container.querySelector("p.font-mono")?.textContent).toBe("Reverted · 0x5d1…07b");
  });

  it("names the decoded error when there is one", () => {
    render(<TxProgress title="t" rows={rows} failure={{ title: "Expired", reverted: "Expired()", hash: HASH }} />);
    expect(screen.getByText(/Reverted: Expired\(\)/).textContent).toBe("Reverted: Expired() · 0x5d1…07b");
  });

  it("shows a transaction still confirming with its link", () => {
    render(<TxProgress title="t" rows={[{ id: "a", label: "Bid", status: "confirming", hash: HASH }]} />);
    expect(screen.getByRole("link").textContent).toBe("Still confirming · 0x5d1…07b");
  });
});

describe("TxProgress gas note", () => {
  const running = [{ id: "a", label: "Bid", status: "running" as const }];
  it("says gas is sponsored only for the embedded wallet", () => {
    render(<TxProgress title="t" rows={running} walletKind="embedded" />);
    expect(screen.getByText(/^Gas sponsored\./)).toBeTruthy();
  });

  it("never claims sponsorship for an external wallet, which pays its own gas", () => {
    render(<TxProgress title="t" rows={running} walletKind="external" />);
    expect(screen.queryByText(/sponsored/i)).toBeNull();
    expect(screen.getByText(/^Paid from your wallet's Sepolia ETH\./)).toBeTruthy();
  });

  it("drops the sponsorship claim once an embedded send fell back to paying its own gas", () => {
    render(<TxProgress title="t" rows={[{ id: "a", label: "Bid", status: "done", gas: "self" }, ...running]} walletKind="embedded" />);
    expect(screen.queryByText(/Gas sponsored/)).toBeNull();
    expect(screen.getByText(/^Sponsorship unavailable, paid from your wallet's Sepolia ETH\./)).toBeTruthy();
  });

  it("makes no gas claim when the wallet is unknown", () => {
    render(<TxProgress title="t" rows={running} />);
    expect(screen.queryByText(/sponsored|Paid from/i)).toBeNull();
    expect(screen.getByText("Keep this open, about 12 seconds per step.")).toBeTruthy();
  });
});

describe("TxProgress without a retry", () => {
  it("offers only the way back when retrying would fail the same way", () => {
    const onCancel = vi.fn();
    render(<TxProgress title="t" rows={rows} failure={{ title: "Taken", reverted: "HandleTaken()", retry: false }} backLabel="Edit handle" onCancel={onCancel} onRetry={() => {}} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit handle" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("describeTxError", () => {
  it("only says nothing was charged when nothing was broadcast", () => {
    expect(describeTxError(null, { name: "Expired", args: [], message: "" }).body).toMatch(/Nothing was sent or charged/);
    expect(describeTxError(null, { name: "Expired", args: [], message: "", hash: HASH }).body).not.toMatch(/charged/);
    expect(describeTxError(null, { name: null, args: [], message: "", hash: HASH }).body).not.toMatch(/charged/);
  });
});
