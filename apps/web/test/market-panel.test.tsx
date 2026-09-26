// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ address: null, identityToken: null, login: vi.fn(), logout: vi.fn() }), apiFetch: vi.fn() }));
vi.mock("@/lib/tx", async () => ({ ...(await vi.importActual<object>("@/lib/tx-core")), useSendTx: () => ({ send: vi.fn(), walletKind: "embedded" }), getReceipt: async () => null }));
vi.mock("@ponder/react", () => ({ usePonderQuery: () => ({ data: [], isSuccess: true }) }));
Object.defineProperty(window, "matchMedia", { value: (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }) });

import { MarketIoContext, MarketPanel, prefillMarket, type MarketIo } from "@/components/market-panel";
import type { CardData } from "@/hooks/use-card";
import type { PoolRow } from "@/lib/market";
import { PAOLO, KENJI, cardFixture } from "@/app/design/card/fixtures";

afterEach(cleanup);

const S = 10n ** 18n;
const NOW = 1_790_000_000;
const MARKET = "0x5555555555555555555555555555555555550ac0";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const ADDRS = {
  usdc: USDC, permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3", universalRouter: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",
  v4Quoter: "0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227", stateView: "0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C", shardMarket: MARKET,
} as const;

const base = cardFixture("sharded", NOW);
function withPool(over: Partial<PoolRow> = {}): CardData {
  const pool = {
    cardId: 1n, poolId: `0x${"11".repeat(32)}`, shardToken: base.sharding!.shardToken, shardIsCurrency0: BigInt(base.sharding!.shardToken) < BigInt(USDC),
    sqrtPriceX96: 0n, priceUsdcPerShard: 1_800_000_000n, seededAt: BigInt(NOW - 3600), seedShards: 8n * S, seedUsdc: 5_000_000_000n, lastSwapAt: null,
    swapCount: 0, volumeUsdc: 0n, frozen: false, lpOwner: PAOLO, feesShards: S / 10n, feesUsdc: 12_340_000n, ...over,
  } as PoolRow;
  return { ...base, pool, swaps: [] };
}

/** Allowances all in place; the quoter answers 2.5 shards for a buy and $4,000 for a sell. */
function io(me: string | null, over: Partial<MarketIo> = {}): Partial<MarketIo> {
  return {
    addresses: ADDRS as never,
    walletKind: "embedded",
    now: () => NOW,
    read: (async (req: { functionName: string; address: string }) => {
      if (req.functionName === "getSlot0") throw new Error("no rpc in tests");
      if (req.functionName === "balanceOf") return req.address === USDC ? 10_000_000_000n : 3n * S;
      if (req.functionName === "allowance" && req.address === ADDRS.permit2) return [2n ** 160n - 1n, NOW + 30 * 86_400, 0];
      if (req.functionName === "allowance") return 2n ** 255n;
      throw new Error(req.functionName);
    }) as never,
    simulate: (async (req: { args: [{ zeroForOne: boolean; exactAmount: bigint }] }) => {
      const buying = req.args[0].exactAmount < S; // USDC amounts are far below 1e18
      return { result: [buying ? 25n * S / 10n : 4_000_000_000n, 1n] };
    }) as never,
    send: vi.fn(),
    ...over,
    ...(me === null ? {} : {}),
  };
}

function renderPanel(c: CardData, me: string | null, ctx: Partial<MarketIo> = io(me)) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (ui: React.ReactNode) => (
    <QueryClientProvider client={qc}><MarketIoContext.Provider value={ctx}>{ui}</MarketIoContext.Provider></QueryClientProvider>
  );
  return render(wrap(<MarketPanel c={c} me={me as `0x${string}` | null} />));
}

describe("MarketPanel", () => {
  it("renders nothing for a card without a pool", () => {
    const { container } = renderPanel({ ...base, pool: null, swaps: [] }, KENJI);
    expect(container.textContent).toBe("");
    cleanup();
    // Older fixtures without the field at all.
    expect(renderPanel(base, KENJI).container.textContent).toBe("");
  });

  it("shows the pool price, implied value and deltas, never NaN", () => {
    renderPanel(withPool(), KENJI);
    expect(screen.getByRole("heading", { name: "Trade shards" })).toBeTruthy();
    expect(screen.getByText("$1,800.00")).toBeTruthy(); // indexer price while StateView is unavailable
    expect(screen.getByText("$28,800.00")).toBeTruthy(); // × 16 shards
    expect(screen.getByText("+5.1%")).toBeTruthy(); // vs the $1,712 clearing
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("says trading closed at buyout on a frozen pool, with no form", () => {
    renderPanel(withPool({ frozen: true }), KENJI);
    expect(screen.getByRole("heading", { name: "Trading closed at buyout" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Buy or sell" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Buy shards|Sell shards/ })).toBeNull();
  });

  it("quotes a buy in USDC with the minimum after 1% slippage, and goes straight to the swap when approved", async () => {
    renderPanel(withPool(), KENJI);
    fireEvent.change(screen.getByLabelText("You pay"), { target: { value: "4,500" } });
    await waitFor(() => expect(screen.getByText("≈ 2.500 shards")).toBeTruthy());
    expect(screen.getByText("2.475 shards")).toBeTruthy();
    expect(screen.getByText("$1,800.00 / shard")).toBeTruthy();
    const cta = screen.getByRole("button", { name: /Buy shards/ }) as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
  });

  it("quotes a sell in shards and refuses more than the wallet holds", async () => {
    renderPanel(withPool(), KENJI);
    fireEvent.click(screen.getByRole("radio", { name: "Sell" }));
    fireEvent.change(screen.getByLabelText("You sell"), { target: { value: "2" } });
    await waitFor(() => expect(screen.getByText("≈ $4,000.00")).toBeTruthy());
    expect(screen.getByText("$3,960.00")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Sell shards/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("You sell"), { target: { value: "5" } });
    await waitFor(() => expect(screen.getByText("You have 3.000 shards.")).toBeTruthy());
    expect((screen.getByRole("button", { name: /Sell shards/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks a logged-out viewer to log in, and still quotes", async () => {
    renderPanel(withPool(), null);
    fireEvent.change(screen.getByLabelText("You pay"), { target: { value: "100" } });
    await waitFor(() => expect(screen.getByText("≈ 2.500 shards")).toBeTruthy());
    expect(screen.getByRole("button", { name: /Log in to trade/ })).toBeTruthy();
  });

  it("offers Collect fees to the LP owner only", () => {
    renderPanel(withPool(), PAOLO);
    expect(screen.getByRole("button", { name: /Collect fees/ })).toBeTruthy();
    expect(screen.getByText("$12.34")).toBeTruthy();
    cleanup();
    renderPanel(withPool(), KENJI);
    expect(screen.queryByRole("button", { name: /Collect fees/ })).toBeNull();
  });

  it("takes a prefill from the redeem panel", async () => {
    renderPanel(withPool(), KENJI);
    fireEvent.click(screen.getByRole("radio", { name: "Sell" }));
    act(() => prefillMarket({ cardId: 1n, side: "buy", amount: "3,650.00", note: "Buys the 2.0 shards you're short of 80%." }));
    await waitFor(() => expect((screen.getByLabelText("You pay") as HTMLInputElement).value).toBe("3,650.00"));
    expect(screen.getByText(/you're short of 80%/)).toBeTruthy();
  });
});
