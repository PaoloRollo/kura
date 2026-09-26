// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Countdown } from "@/components/countdown";
import { countdownSeconds, money } from "@/lib/format";

const head = { number: 1000, timestamp: 1_790_000_000 };
vi.mock("@ponder/react", () => ({ usePonderStatus: () => ({ data: { sepolia: { block: head } } }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Countdown", () => {
  it("ticks every second from the indexer head's timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(head.timestamp * 1000);
    render(<Countdown endBlock={1028n} />); // 28 blocks = 5:36
    expect(screen.getByText("05:36")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByText("05:35")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByText("05:33")).toBeTruthy();
  });

  it("stops at zero once the deadline passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime((head.timestamp + 60) * 1000);
    render(<Countdown endBlock={1002n} />);
    act(() => void vi.advanceTimersByTime(0)); // the first tick runs right after mount
    expect(screen.getByText("00:00")).toBeTruthy();
  });
});

describe("formatting", () => {
  it("formats seconds like the block countdown", () => {
    expect(countdownSeconds(334)).toBe("05:34");
    expect(countdownSeconds(4330)).toBe("1:12:10");
    expect(countdownSeconds(-5)).toBe("00:00");
  });

  it("shows cents on every amount so small bids don't read $0", () => {
    expect(money(220_000n)).toBe("$0.22");
    expect(money(17_500_000n)).toBe("$17.50");
    expect(money(1_712_000_000n)).toBe("$1,712.00");
  });
});
