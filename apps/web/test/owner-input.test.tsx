// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getAddress } from "viem";
import { OwnerHandleInput } from "@/components/vendor/owner-input";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const KENJI = "0x4f2ca0b3ae1f3d7a0b6d2f0c1e4b5a6d7c8ea81e";

describe("OwnerHandleInput", () => {
  it("looks the handle up once typing pauses and hands over the resolved address", async () => {
    vi.useFakeTimers();
    const byLabel = vi.fn(async (l: string) => (l === "kenji" ? KENJI : null));
    const onUse = vi.fn();
    render(<OwnerHandleInput onUse={onUse} directory={{ byLabel, byAddress: async () => null }} />);
    const input = screen.getByLabelText("Owner's Kura handle");
    const use = screen.getByRole("button", { name: "Use handle" }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "ken" } });
    fireEvent.change(input, { target: { value: "kenji" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(byLabel).not.toHaveBeenCalled();
    expect(use.disabled).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => {});
    expect(byLabel).toHaveBeenCalledTimes(1);
    expect(byLabel).toHaveBeenCalledWith("kenji");
    expect(document.querySelector("p[aria-live]")?.textContent).toMatch(/^kenji\.kura\.eth · 0x4f2c…a81e$/i);
    expect(use.disabled).toBe(false);

    fireEvent.click(use);
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ address: getAddress(KENJI), name: "kenji.kura.eth" }));
  });

  it("keeps Use disabled and explains a rejected handle", async () => {
    vi.useFakeTimers();
    render(<OwnerHandleInput onUse={vi.fn()} directory={{ byLabel: async () => null, byAddress: async () => null }} />);
    fireEvent.change(screen.getByLabelText("Owner's Kura handle"), { target: { value: "black-lotus-lea-1" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => {});
    expect(screen.getByText("That's a card name, not a collector")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Use handle" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
