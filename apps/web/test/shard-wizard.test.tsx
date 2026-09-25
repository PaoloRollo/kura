// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
vi.mock("@ponder/react", () => ({ usePonderQuery: () => ({ data: undefined, isSuccess: false }), usePonderStatus: () => ({ data: undefined }) }));

import { ShardWizard, price, type ShardDone } from "@/components/shard-wizard";
import type { CardData } from "@/hooks/use-card";
import type { ShardParams } from "@/lib/shard-math";
import { KENJI, PAOLO, cardFixture } from "@/app/design/card/fixtures";

afterEach(cleanup);

// Radix's Slider measures its thumbs; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const NOW = 1_790_000_000;
const HREF = "/app/cards/1";

function renderWizard(c: CardData, opts: { me?: string | null; done?: ShardDone } = {}) {
  const submit = vi.fn<(p: ShardParams, disabled: boolean) => void>();
  const view = render(
    <ShardWizard
      c={c}
      me={opts.me === undefined ? PAOLO : opts.me}
      feeBps={250}
      now={NOW}
      cardHref={HREF}
      initialDone={opts.done}
      renderSubmit={(p, disabled, onDone) => {
        submit(p, disabled);
        return <button type="button" disabled={disabled} onClick={() => onDone({ params: p, hash: "0x3a1f00000000000000000000000000000000000000000000000000000000c9f2", at: NOW })}>Create shards and open auction</button>;
      }}
    />,
  );
  return { ...view, submit };
}

describe("ShardWizard", () => {
  it("walks the three steps with market-priced defaults and hands the contract's params to the CTA", () => {
    const { submit } = renderWizard(cardFixture("whole-owner", NOW));
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByText("You keep 24")).toBeTruthy();
    expect(screen.getByText("8 of 32")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Close" }).getAttribute("href")).toBe(HREF);
    fireEvent.click(screen.getByRole("button", { name: /Next: set floor price/ }));

    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getByText("Scryfall market $25,000")).toBeTruthy();
    expect((screen.getByLabelText("Floor price per shard") as HTMLInputElement).value).toBe("781.25");
    expect((screen.getByLabelText("Price tick") as HTMLInputElement).value).toBe("7.8125");
    expect(screen.getByText("$6,093.75")).toBeTruthy(); // 8 × $781.25 less 2.5%
    fireEvent.click(screen.getByRole("button", { name: /Next: duration/ }));

    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "1 week" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "5 min" }));
    expect(screen.getByText("black-lotus-lea-1.kura.eth")).toBeTruthy();
    expect(submit).toHaveBeenLastCalledWith(
      { totalShards: 32, forSale: 8, floorUsdcPerShard: 781_250_000n, tickUsdcPerShard: 7_812_500n, reserveUsdc: 0n, durationBlocks: 25 },
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("2 of 3")).toBeTruthy();
  });

  it("shows validation under the input and blocks the next step", () => {
    renderWizard(cardFixture("whole-owner", NOW));
    fireEvent.click(screen.getByRole("button", { name: /Next: set floor price/ }));
    fireEvent.change(screen.getByLabelText("Price tick"), { target: { value: "0.3" } });
    expect(screen.getByRole("alert").textContent).toMatch(/multiple of the tick/);
    expect((screen.getByRole("button", { name: /Next: duration/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Price tick"), { target: { value: "0.25" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("picks a tick that divides a typed floor", () => {
    renderWizard(cardFixture("whole-owner", NOW));
    fireEvent.click(screen.getByRole("button", { name: /Next: set floor price/ }));
    fireEvent.change(screen.getByLabelText("Floor price per shard"), { target: { value: "1,200" } });
    expect((screen.getByLabelText("Price tick") as HTMLInputElement).value).toBe("12.00");
  });

  it("falls back to 1 USDC per shard without a market price", () => {
    const c = cardFixture("whole-owner", NOW);
    renderWizard({ ...c, price: { ...c.price!, usd: null, adjustedUsd: null } });
    fireEvent.click(screen.getByRole("button", { name: /Next: set floor price/ }));
    expect(screen.getByText("No market price yet")).toBeTruthy();
    expect((screen.getByLabelText("Floor price per shard") as HTMLInputElement).value).toBe("1.00");
    expect((screen.getByLabelText("Price tick") as HTMLInputElement).value).toBe("0.01");
  });

  it("turns away anyone but the owner of a whole card, with a way back", () => {
    renderWizard(cardFixture("whole-owner", NOW), { me: KENJI });
    expect(screen.getByText(/Only the card's owner can shard it/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to the card" }).getAttribute("href")).toBe(HREF);
    cleanup();
    renderWizard(cardFixture("auctioning", NOW));
    expect(screen.getByText(/already up for auction/)).toBeTruthy();
  });

  it("ends on a confirmation with the tx and the way to the auction, even once the card is auctioning", () => {
    const { rerender } = renderWizard(cardFixture("whole-owner", NOW));
    fireEvent.click(screen.getByRole("button", { name: /Next: set floor price/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next: duration/ }));
    // The indexer flips the card to auctioning before the stepper resolves: the form must stay.
    const auctioning = cardFixture("auctioning", NOW);
    rerender(<ShardWizard c={auctioning} me={PAOLO} feeBps={250} now={NOW} cardHref={HREF} renderSubmit={(p, disabled, onDone) => <button type="button" onClick={() => onDone({ params: p, hash: "0x3a1f00000000000000000000000000000000000000000000000000000000c9f2", at: NOW })}>Create shards and open auction</button>} />);
    fireEvent.click(screen.getByRole("button", { name: "Create shards and open auction" }));
    expect(screen.getByText("Your auction is live")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByRole("link", { name: /0x3a1…9f2/ }).getAttribute("href")).toMatch(/etherscan\.io\/tx\/0x3a1f/);
    expect(screen.getByRole("link", { name: "Open the auction" }).getAttribute("href")).toBe(`${HREF}?tab=auction`);
    expect(screen.getByRole("link", { name: "Back to the card" }).getAttribute("href")).toBe(HREF);
  });
});

describe("price", () => {
  it("shows whole dollars, cents, or every digit that carries value", () => {
    expect(price(1_200_000_000n)).toBe("$1,200");
    expect(price(781_250_000n)).toBe("$781.25");
    expect(price(7_812_500n)).toBe("$7.8125");
    expect(price(9_360_039_000n)).toBe("$9,360.039");
  });
});
