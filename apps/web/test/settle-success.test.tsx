// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, renderHook } from "@testing-library/react";
import { OwnerSettled, showOwnerSettled, useOwnerSettled, type SettledInfo } from "@/components/settle-success";

afterEach(() => {
  cleanup();
  showOwnerSettled(null);
});

const info: SettledInfo = { cardId: 1n, hash: `0x${"1".repeat(64)}`, raisedUsdc: 5_136_000_000n, feeUsdc: 128_400_000n, graduated: true, clearingQ96: 0n, sold: 3 };

describe("OwnerSettled", () => {
  it("forgets the settled info when the seller opens another auction", () => {
    showOwnerSettled(info);
    const hook = renderHook(() => useOwnerSettled(1n));
    expect(hook.result.current).not.toBeNull();
    render(<OwnerSettled info={info} cardName="Black Lotus" sold={3} buyers={2} onClose={() => {}} />);
    const link = screen.getByRole("link", { name: /open another auction/i });
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link);
    hook.rerender();
    expect(hook.result.current).toBeNull();
  });
});
