// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

describe("describeTxError", () => {
  it("only says nothing was charged when nothing was broadcast", () => {
    expect(describeTxError(null, { name: "Expired", args: [], message: "" }).body).toMatch(/Nothing was sent or charged/);
    expect(describeTxError(null, { name: "Expired", args: [], message: "", hash: HASH }).body).not.toMatch(/charged/);
    expect(describeTxError(null, { name: null, args: [], message: "", hash: HASH }).body).not.toMatch(/charged/);
  });
});
