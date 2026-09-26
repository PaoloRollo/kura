// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FeeSaved } from "@/components/vendor/fees";
import { explorerTx } from "@/lib/chain";

afterEach(cleanup);

describe("FeeSaved", () => {
  it("confirms the new fee with its tx link, and closes on Done", () => {
    const hash = `0x${"ab".repeat(32)}` as const;
    const onClose = vi.fn();
    render(<FeeSaved bps={300} hash={hash} onClose={onClose} />);
    expect(screen.getByText("Vault fee set to 3%")).toBeTruthy();
    expect(screen.getByRole("link", { name: /tx/i }).getAttribute("href")).toBe(explorerTx(hash));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });
});
