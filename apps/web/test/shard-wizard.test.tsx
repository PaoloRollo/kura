// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useMemo, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("@ponder/react", () => ({ usePonderQuery: () => ({ data: undefined, isSuccess: false }), usePonderStatus: () => ({ data: undefined }) }));

import { ShardWizard, price, type ShardDone, type StepNav, type WizardStep } from "@/components/shard-wizard";
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
const HASH = "0x3a1f00000000000000000000000000000000000000000000000000000000c9f2";

type Handle = { back: () => void; forward: () => void; entries: () => (WizardStep | null)[]; setCard: (c: CardData) => void; finish: (d: ShardDone) => void };

/** The wizard under an in-memory history, standing in for `?step=` and the browser's back and forward buttons. */
const handle = {} as Handle;

function Harness({ c: initial, me, start, onSubmit }: { c: CardData; me: string | null; start: WizardStep | null; onSubmit: (p: ShardParams, disabled: boolean) => void }) {
  const [hist, setHist] = useState<{ stack: (WizardStep | null)[]; i: number }>({ stack: [start], i: 0 });
  const [c, setCard] = useState(initial);
  const [finish, setFinish] = useState<((d: ShardDone) => void) | null>(null);
  const nav = useMemo<StepNav>(() => ({
    step: hist.stack[hist.i],
    go: (s) => setHist((h) => ({ stack: [...h.stack.slice(0, h.i + 1), s], i: h.i + 1 })),
    replace: (s) => setHist((h) => ({ stack: h.stack.map((x, j) => (j === h.i ? s : x)), i: h.i })),
    back: () => setHist((h) => ({ ...h, i: Math.max(0, h.i - 1) })),
  }), [hist]);
  useEffect(() => {
    handle.back = nav.back;
    handle.forward = () => setHist((h) => ({ ...h, i: Math.min(h.stack.length - 1, h.i + 1) }));
    handle.entries = () => hist.stack;
    handle.setCard = setCard;
    handle.finish = (d) => finish?.(d);
  }, [nav.back, hist.stack, finish]);
  return (
    <ShardWizard
      c={c}
      me={me}
      feeBps={250}
      now={NOW}
      cardHref={HREF}
      nav={nav}
      renderSubmit={(p, disabled, onDone) => {
        onSubmit(p, disabled);
        return (
          <button type="button" disabled={disabled} onClick={() => setFinish(() => onDone)}>Create shards and open auction</button>
        );
      }}
    />
  );
}

function renderWizard(c: CardData, opts: { me?: string | null; start?: WizardStep | null } = {}) {
  const submit = vi.fn<(p: ShardParams, disabled: boolean) => void>();
  render(<Harness c={c} me={opts.me === undefined ? PAOLO : opts.me} start={opts.start ?? null} onSubmit={submit} />);
  return { submit, handle };
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const toPricing = () => fireEvent.click(screen.getByRole("button", { name: /Next: set floor price/ }));
const toReview = () => fireEvent.click(screen.getByRole("button", { name: /Next: duration/ }));

describe("ShardWizard", () => {
  it("walks the three steps with market-priced defaults and hands the contract's params to the CTA", () => {
    const { submit } = renderWizard(cardFixture("whole-owner", NOW));
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByText("Auction 16")).toBeTruthy();
    expect(screen.getByText("Pool 16")).toBeTruthy();
    expect(screen.queryByRole("slider", { name: "Shards for sale" })).toBeNull();
    expect(screen.getByText(/Half the shards are sold in the auction\. The other half, with the auction proceeds, opens a Uniswap pool at the clearing price\. You earn the pool's trading fees until the card is bought out\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Close" }).getAttribute("href")).toBe(HREF);
    toPricing();

    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getByText("Scryfall market $25,000.00")).toBeTruthy();
    expect(input("Floor price per shard").value).toBe("781.25");
    expect(input("Price tick").value).toBe("7.8125");
    expect(screen.getByLabelText("Reserve (total, optional)")).toBeTruthy();
    expect(screen.getByText("$12,187.50")).toBeTruthy(); // 16 × $781.25 less 2.5%, into the pool
    toReview();

    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "1 week" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "5 min" }));
    expect(screen.getByText("black-lotus-lea-1.kura.eth")).toBeTruthy();
    expect(submit).toHaveBeenLastCalledWith(
      { totalShards: 32, floorUsdcPerShard: 781_250_000n, tickUsdcPerShard: 7_812_500n, reserveUsdc: 0n, durationBlocks: 25 },
      false,
    );
  });

  it("keeps the step in the history: back goes back one step and forward returns with the form intact", () => {
    const { handle } = renderWizard(cardFixture("whole-owner", NOW), { start: 1 });
    toPricing();
    toReview();
    expect(handle.entries()).toEqual([1, 2, 3]);
    act(() => handle.back());
    expect(screen.getByText("2 of 3")).toBeTruthy();
    fireEvent.change(input("Floor price per shard"), { target: { value: "1,200" } });
    act(() => handle.forward());
    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(screen.getByText("$1,200.00 · $12.00")).toBeTruthy();
    // The Nav row's back chevron is the same history step.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("2 of 3")).toBeTruthy();
  });

  it("clamps a cold load of a later step to step 1, since there is no form state", () => {
    const { handle } = renderWizard(cardFixture("whole-owner", NOW), { start: 3 });
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(handle.entries()).toEqual([1]);
  });

  it("says why the CTA is disabled when a setting on an earlier step broke", () => {
    const { handle, submit } = renderWizard(cardFixture("whole-owner", NOW), { start: 1 });
    toPricing();
    toReview();
    act(() => handle.back());
    fireEvent.change(input("Floor price per shard"), { target: { value: "abc" } });
    act(() => handle.forward());
    expect(screen.getByText("Fix the floor, tick or reserve on step 2 first.")).toBeTruthy();
    expect(submit).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  it("puts a floor off the tick under whichever field was edited, with a one-tap round", () => {
    renderWizard(cardFixture("whole-owner", NOW));
    toPricing();
    fireEvent.change(input("Price tick"), { target: { value: "0.3" } });
    const tickField = input("Price tick").closest("[data-slot=amount-input]")!.parentElement!;
    expect(tickField.textContent).toMatch(/multiple of the tick/);
    expect((screen.getByRole("button", { name: /Next: duration/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input("Floor price per shard"), { target: { value: "781.26" } });
    const floorField = input("Floor price per shard").closest("[data-slot=amount-input]")!.parentElement!;
    expect(floorField.textContent).toMatch(/multiple of the tick/);
    expect(tickField.textContent).not.toMatch(/multiple of the tick/);
    fireEvent.click(screen.getByRole("button", { name: "Round to $781.20" }));
    expect(input("Floor price per shard").value).toBe("781.20");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("picks a tick that divides a typed floor, or keeps 1% and offers to round", () => {
    renderWizard(cardFixture("whole-owner", NOW));
    toPricing();
    fireEvent.change(input("Floor price per shard"), { target: { value: "1,200" } });
    expect(input("Price tick").value).toBe("12.00");
    // Only 10 units divides 1,234.56789: far below 0.1%, so the tick stays at 1% (rounded up) and the floor must move.
    fireEvent.change(input("Floor price per shard"), { target: { value: "1,234.56789" } });
    expect(input("Price tick").value).toBe("12.345679");
    fireEvent.click(screen.getByRole("button", { name: "Round to $1,234.5679" }));
    expect(input("Floor price per shard").value).toBe("1,234.5679");
    expect(input("Price tick").value).toBe("12.345679");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("falls back to 1 USDC per shard without a market price, or with a zero one", () => {
    const c = cardFixture("whole-owner", NOW);
    for (const adjustedUsd of [null, "0.00"]) {
      renderWizard({ ...c, price: { ...c.price!, usd: adjustedUsd, adjustedUsd } });
      expect(screen.getAllByText("n/a").length).toBe(2); // Market and Per shard on step 1
      toPricing();
      expect(screen.getByText("No market price yet")).toBeTruthy();
      expect(input("Floor price per shard").value).toBe("1.00");
      expect(input("Price tick").value).toBe("0.01");
      cleanup();
    }
  });

  it("turns away anyone but the owner of a whole card, with a way back", () => {
    renderWizard(cardFixture("whole-owner", NOW), { me: KENJI });
    expect(screen.getByText(/Only the card's owner can shard it/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to the card" }).getAttribute("href")).toBe(HREF);
    cleanup();
    renderWizard(cardFixture("auctioning", NOW));
    expect(screen.getByText(/already up for auction/)).toBeTruthy();
  });

  it("confirms with the auction read from the receipt, even once the card is auctioning", () => {
    const { handle } = renderWizard(cardFixture("whole-owner", NOW));
    toPricing();
    toReview();
    // The indexer flips the card to auctioning before the stepper resolves: the form must stay.
    act(() => handle.setCard(cardFixture("auctioning", NOW)));
    fireEvent.click(screen.getByRole("button", { name: "Create shards and open auction" }));
    const params: ShardParams = { totalShards: 32, floorUsdcPerShard: 781_250_000n, tickUsdcPerShard: 7_812_500n, reserveUsdc: 0n, durationBlocks: 50_400 };
    act(() => handle.finish({ params, hash: HASH, at: NOW }));
    expect(screen.getByText("Your auction is live")).toBeTruthy();
    expect(screen.getByText(/16 are up for auction\. The other 16 open a Uniswap pool/)).toBeTruthy();
    expect(screen.getByText("reading the receipt…")).toBeTruthy();
    act(() =>
      handle.finish({
        params, hash: HASH, at: NOW,
        created: { shardToken: "0x8c0B76235b3c4D179C0576517ae1C66640C8cEBf", auction: "0xdb6E8ADEdfd5dA3A50b9c738755770EDD98E5cCb", endBlock: 1_050_400n, refBlock: 1_000_000n, hash: HASH, source: "receipt" },
      }),
    );
    expect(screen.getByRole("link", { name: /0xdb6E…5cCb/ }).getAttribute("href")).toMatch(/etherscan\.io\/address\/0xdb6E8ADEdfd5dA3A50b9c738755770EDD98E5cCb/);
    expect(screen.getByRole("link", { name: /0x8c0B…cEBf/ }).getAttribute("href")).toMatch(/address\/0x8c0B/);
    expect(screen.getByText(/· block 1,050,400/)).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByRole("link", { name: /0x3a1…9f2/ }).getAttribute("href")).toMatch(/etherscan\.io\/tx\/0x3a1f/);
    expect(screen.getByRole("link", { name: "Open the auction" }).getAttribute("href")).toBe(`${HREF}?tab=auction`);
    expect(screen.getByRole("link", { name: "Back to the card" }).getAttribute("href")).toBe(HREF);
  });

  it("links the indexer's shard transaction when a retry found the step already done", () => {
    const auctioning = cardFixture("auctioning", NOW);
    const { handle } = renderWizard(cardFixture("whole-owner", NOW));
    toPricing();
    toReview();
    act(() => handle.setCard(auctioning));
    fireEvent.click(screen.getByRole("button", { name: "Create shards and open auction" }));
    const s = auctioning.sharding!;
    const tx = auctioning.activities.find((a) => a.kind === "shard")!.txHash;
    act(() =>
      handle.finish({
        params: { totalShards: 16, floorUsdcPerShard: 1n, tickUsdcPerShard: 1n, reserveUsdc: 0n, durationBlocks: 25 },
        at: NOW,
        created: { shardToken: s.shardToken, auction: s.auction, endBlock: 1_000_025n, refBlock: 1_000_000n, hash: null, source: "vault" },
      }),
    );
    expect(screen.getByRole("link", { name: new RegExp(`${tx.slice(0, 5)}…${tx.slice(-3)}`) }).getAttribute("href")).toBe(`https://sepolia.etherscan.io/tx/${tx}`);
  });
});

describe("price", () => {
  it("shows two decimals, or every digit that carries value", () => {
    expect(price(1_200_000_000n)).toBe("$1,200.00");
    expect(price(781_250_000n)).toBe("$781.25");
    expect(price(7_812_500n)).toBe("$7.8125");
    expect(price(9_360_039_000n)).toBe("$9,360.039");
  });
});
