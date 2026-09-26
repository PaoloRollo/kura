// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ address: "0x4f2c6e1a0b3d5f7a9c1e3b5d7f9a1c3e5b7da81e", identityToken: null, login: vi.fn(), logout: vi.fn() }), apiFetch: vi.fn() }));
vi.mock("@/lib/tx", async () => ({ ...(await vi.importActual<object>("@/lib/tx-core")), useSendTx: () => ({ send: vi.fn(), walletKind: "embedded" }), getReceipt: async () => null }));
vi.mock("@ponder/react", () => ({ usePonderQuery: () => ({ data: [], isSuccess: true }) }));
Object.defineProperty(window, "matchMedia", { value: (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }) });

import { usdcPerShardToQ96 } from "@kura/shared";
import { RedeemPanel } from "@/components/redeem-panel";
import { PayoutPanel } from "@/components/payout-panel";
import { SendShardsSheet, parseShardAmount } from "@/components/send-shards";
import { VaultIoContext, type VaultIo, type VaultRead } from "@/components/vault-io";
import { MarketIoContext, MarketPanel } from "@/components/market-panel";
import { shortfallBudget, type PoolRow } from "@/lib/market";
import { HandlesFixture } from "@/hooks/use-handles";
import { showVaultSuccess, useVaultSuccess } from "@/components/vault-success";
import { resetAppraisalThrottleForTests, retryDelayMs, canAttemptAppraisal } from "@/lib/appraisal-refresh";
import type { AppraiseResult } from "@/lib/appraise";
import { buyoutQuote, dropsBelowThreshold, payoutFor, shardsShort } from "@/lib/buyout";
import { addresses } from "@/lib/chain";
import type { SendInput, Sent } from "@/lib/tx-core";
import { HANDLES, KENJI, PAOLO, cardFixture } from "@/app/design/card/fixtures";

afterEach(cleanup);
beforeEach(() => {
  resetAppraisalThrottleForTests();
  showVaultSuccess(null);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sepolia: { block: { number: 10 } } }))));
});
const S = 10n ** 18n;
const usd = (d: number) => BigInt(Math.round(d * 100)) * 10_000n;

describe("buyout math", () => {
  it("prices at the higher of clearing and appraisal and charges the fee on top", () => {
    const q = buyoutQuote({ supply: 16n * S, balance: 13n * S, clearingQ96: usdcPerShardToQ96(usd(1712)), appraisedUsdcPerShard: usd(1587.5), feeBps: 250n });
    expect(q.eligible).toBe(true);
    expect(q.price).toBe(usd(1712));
    expect(q.payout).toBe(usd(5136));
    expect(q.fee).toBe(usd(128.4));
    expect(q.total).toBe(usd(5264.4));
    const higher = buyoutQuote({ supply: 16n * S, balance: 13n * S, clearingQ96: usdcPerShardToQ96(usd(1712)), appraisedUsdcPerShard: usd(1800), feeBps: 250n });
    expect(higher.price).toBe(usd(1800));
  });

  it("floors like PriceMath and needs nothing from a full holder", () => {
    expect(payoutFor(3n, S / 2n)).toBe(1n);
    const full = buyoutQuote({ supply: 16n * S, balance: 16n * S, clearingQ96: usdcPerShardToQ96(usd(1712)), appraisedUsdcPerShard: usd(9999), feeBps: 250n });
    expect(full).toMatchObject({ full: true, eligible: true, payout: 0n, fee: 0n, total: 0n });
  });

  it("uses the threshold bal*5 >= supply*4", () => {
    expect(buyoutQuote({ supply: 16n * S, balance: 128n * S / 10n, clearingQ96: 0n, appraisedUsdcPerShard: 0n, feeBps: 0n }).eligible).toBe(true);
    expect(buyoutQuote({ supply: 16n * S, balance: 128n * S / 10n - 1n, clearingQ96: 0n, appraisedUsdcPerShard: 0n, feeBps: 0n }).eligible).toBe(false);
    expect(shardsShort(75n * S / 10n, 16n * S)).toBe(53n * S / 10n);
    expect(shardsShort(13n * S, 16n * S)).toBe(0n);
    expect(dropsBelowThreshold(13n * S, 16n * S, S)).toBe(true);
    expect(dropsBelowThreshold(16n * S, 16n * S, S)).toBe(false);
    expect(dropsBelowThreshold(10n * S, 16n * S, S)).toBe(false);
  });

  it("parses shard amounts", () => {
    expect(parseShardAmount("1.0")).toBe(S);
    expect(parseShardAmount("0.5")).toBe(S / 2n);
    expect(parseShardAmount("0")).toBeNull();
    expect(parseShardAmount("abc")).toBeNull();
    expect(parseShardAmount("1.0000000000000000001")).toBeNull();
  });
});

const TOKEN = cardFixture("sharded", 0).sharding!.shardToken;

function chainRead(over: Record<string, unknown> = {}) {
  return async <T,>(req: VaultRead): Promise<T> => {
    const token = req.address.toLowerCase() === TOKEN.toLowerCase();
    const v: Record<string, unknown> = {
      totalSupply: 16n * S, balanceOf: token ? 13n * S : usd(6120), allowance: 0n, feeBps: 250,
      shardings: { clearingPriceQ96: usdcPerShardToQ96(usd(1712)) }, cards: { state: 3, beneficialOwner: PAOLO }, ...over,
    };
    const x = v[req.functionName];
    return (typeof x === "function" ? x(req) : x) as T;
  };
}

const appraisal = (usdcPerShard: bigint, ttl = 600): AppraiseResult => ({
  appraisal: { cardId: "1", shardToken: TOKEN, usdcPerShard: usdcPerShard.toString(), expiresAt: String(Math.floor(Date.now() / 1000) + ttl) },
  signature: "0xabcd", marketUsd: "25400.00", adjustedUsd: "25400", conditionMultiplier: 1, priceSource: "Scryfall USD · nonfoil · EN printing · NM ×1.00",
  source: "scryfall", pricedAt: Math.floor(Date.now() / 1000), clearingUsdcPerShard: usd(1712).toString(),
});

function wrap(ui: React.ReactNode, io: Partial<VaultIo>) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <HandlesFixture.Provider value={HANDLES}>
        <VaultIoContext.Provider value={io}>{ui}</VaultIoContext.Provider>
      </HandlesFixture.Provider>
    </QueryClientProvider>,
  );
}

const sent = (): Sent => ({ hash: `0x${"1".repeat(64)}`, receipt: { status: "success", blockNumber: 1n, logs: [], transactionHash: `0x${"1".repeat(64)}` } as never });

describe("RedeemPanel", () => {
  it("quotes a non-graduated auction at its Q96 clearing price and approves payout + fee before redeeming", async () => {
    const c = cardFixture("sharded", 1_790_000_000);
    const nonGrad = { ...c, sharding: { ...c.sharding!, graduated: false, clearingUsdcPerShard: null } };
    const send = vi.fn<(i: SendInput) => Promise<Sent>>(async () => sent());
    wrap(<RedeemPanel c={nonGrad} me={PAOLO} />, { read: chainRead(), send, appraise: async () => appraisal(usd(1587.5)), walletKind: "embedded" });
    await waitFor(() => expect(screen.getAllByText("$5,264.40").length).toBeGreaterThan(0));
    expect(screen.getByText("You can take this card home", { selector: "h2.font-display.text-\\[28px\\]" })).toBeTruthy();
    expect(screen.getByText(/Paid to kenji, 0x7a3f…91c2, aiko/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Buy out and redeem/ }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const [approve, redeem] = send.mock.calls.map((x) => x[0]);
    expect(approve).toMatchObject({ to: addresses.usdc, functionName: "approve", args: [addresses.cardVault, usd(5264.4)] });
    expect(redeem).toMatchObject({ to: addresses.cardVault, functionName: "redeem" });
    expect(redeem.args![1]).toEqual({ cardId: 1n, shardToken: TOKEN, usdcPerShard: usd(1587.5), expiresAt: expect.any(BigInt) });
    expect(redeem.args![2]).toBe("0xabcd");
  });

  it("disables the buyout without enough USDC", async () => {
    const c = cardFixture("sharded", 1_790_000_000);
    wrap(<RedeemPanel c={c} me={PAOLO} />, { read: chainRead({ balanceOf: (r: VaultRead) => (r.address.toLowerCase() === TOKEN.toLowerCase() ? 13n * S : usd(100)) }), appraise: async () => appraisal(usd(1587.5)) });
    await waitFor(() => expect(screen.getAllByText(/Not enough USDC/).length).toBeGreaterThan(0));
    expect((screen.getAllByRole("button", { name: /Buy out and redeem/ })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows how far below 80% a holder is", async () => {
    const c = cardFixture("sharded", 1_790_000_000);
    wrap(<RedeemPanel c={c} me={PAOLO} />, { read: chainRead({ balanceOf: (r: VaultRead) => (r.address.toLowerCase() === TOKEN.toLowerCase() ? 75n * S / 10n : usd(100)) }), appraise: vi.fn() });
    await waitFor(() => expect(screen.getByText("5.3 shards short")).toBeTruthy());
    expect(screen.getByText(/You hold 7.5 of 16/)).toBeTruthy();
  });

  it("quotes the shortfall on the pool and fills the market form with it", async () => {
    const c = cardFixture("sharded", 1_790_000_000);
    const pool = { cardId: 1n, poolId: `0x${"11".repeat(32)}`, shardToken: TOKEN, shardIsCurrency0: true, sqrtPriceX96: 0n, priceUsdcPerShard: usd(1800), seededAt: 1n,
      seedShards: 8n * S, seedUsdc: 1n, lastSwapAt: null, swapCount: 0, volumeUsdc: 0n, frozen: false, lpOwner: PAOLO, feesShards: 0n, feesUsdc: 0n } as PoolRow;
    const withPool = { ...c, pool, swaps: [] };
    // Exact-out: 5.3 shards cost $9,540.00 on the pool.
    const simulate = vi.fn(async (req: { functionName: string }) => ({ result: [req.functionName === "quoteExactOutputSingle" ? usd(9540) : 53n * S / 10n, 1n] }));
    const read = chainRead({ balanceOf: (r: VaultRead) => (r.address.toLowerCase() === TOKEN.toLowerCase() ? 75n * S / 10n : usd(20_000)), allowance: 2n ** 200n });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HandlesFixture.Provider value={HANDLES}>
          <VaultIoContext.Provider value={{ read, appraise: vi.fn() }}>
            <MarketIoContext.Provider value={{ read: read as never, simulate: simulate as never, walletKind: "embedded" }}>
              <RedeemPanel c={withPool} me={PAOLO} />
              <MarketPanel c={withPool} me={PAOLO} />
            </MarketIoContext.Provider>
          </VaultIoContext.Provider>
        </HandlesFixture.Provider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("≈ $9,540.00")).toBeTruthy());
    expect(screen.getByText(/Buy the rest from the pool/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Buy from pool/ }));
    // The quote plus 1% headroom, rounded up to a cent.
    await waitFor(() => expect((screen.getByLabelText("You pay") as HTMLInputElement).value).toBe("9,635.40"));
    expect(shortfallBudget(usd(9540))).toBe(usd(9635.4));
    expect(shortfallBudget(1n)).toBe(10_000n);
  });

  it("reassembles for a full holder without an appraisal", async () => {
    const c = cardFixture("sharded", 1_790_000_000);
    const appraise = vi.fn();
    const send = vi.fn<(i: SendInput) => Promise<Sent>>(async () => sent());
    wrap(<RedeemPanel c={c} me={PAOLO} />, { read: chainRead({ balanceOf: (r: VaultRead) => (r.address.toLowerCase() === TOKEN.toLowerCase() ? 16n * S : 0n) }), appraise, send });
    fireEvent.click(await screen.findByRole("button", { name: /Reassemble card/ }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toMatchObject({ functionName: "redeem", args: [1n, { cardId: 0n, usdcPerShard: 0n, expiresAt: 0n }, "0x"] });
    expect(appraise).not.toHaveBeenCalled();
  });
});

describe("PayoutPanel", () => {
  it("offers balance × buyout price and claims with claimPayout", async () => {
    const send = vi.fn<(i: SendInput) => Promise<Sent>>(async () => sent());
    wrap(<PayoutPanel me={KENJI} cardName="Black Lotus" sharding={{ cardId: 1n, shardToken: TOKEN, buyoutPerShard: usd(1840), redeemer: PAOLO }} />, { read: chainRead({ balanceOf: S }), send });
    fireEvent.click(await screen.findByRole("button", { name: "Claim $1,840.00" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toMatchObject({ to: addresses.cardVault, functionName: "claimPayout", args: [TOKEN] });
  });
});

describe("PayoutPanel for the pool's LP owner", () => {
  it("says the shards came back from the pool and claims them the same way", async () => {
    wrap(<PayoutPanel me={PAOLO} fromPool cardName="Black Lotus" sharding={{ cardId: 1n, shardToken: TOKEN, buyoutPerShard: usd(1840), redeemer: KENJI }} />, { read: chainRead({ balanceOf: 5n * S }) });
    expect(await screen.findByText(/The pool closed and its liquidity came back to you/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claim $9,200.00" })).toBeTruthy();
  });
});

describe("SendShardsSheet", () => {
  it("resolves a handle, warns below 80% and transfers", async () => {
    const send = vi.fn<(i: SendInput) => Promise<Sent>>(async () => sent());
    const resolveHandle = vi.fn(async () => ({ ok: true as const, address: KENJI, name: "kenji.kura.eth" }));
    wrap(<SendShardsSheet open onOpenChange={() => {}} cardName="Black Lotus" shardToken={TOKEN} balance={13n * S} supply={16n * S} initialTo="kenji" />, { read: chainRead(), send, resolveHandle });
    await waitFor(() => expect(screen.getByText("0x1ee0…4b3c")).toBeTruthy());
    expect(screen.getByText(/After sending you'll hold 12.0 \(75%\), below the 80% needed to redeem/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Send 1.0 shard$/ }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toMatchObject({ to: TOKEN, functionName: "transfer", args: [KENJI, S] });
  });
});

describe("appraisal refresh", () => {
  it("backs off exponentially and never allows two requests within 10 s", () => {
    expect([0, 1, 2, 3, 10].map(retryDelayMs)).toEqual([0, 10_000, 20_000, 40_000, 300_000]);
    expect(canAttemptAppraisal(Date.now())).toBe(true);
  });

  it("does not storm the server while the appraisal keeps failing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    try {
      const appraise = vi.fn(async () => { throw new Error("rate limited"); });
      wrap(<RedeemPanel c={cardFixture("sharded", 1_790_000_000)} me={PAOLO} />, { read: chainRead(), appraise });
      for (let i = 0; i < 90; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      // t≈0, then 10 s and 20 s of backoff after each failure: 0, 10, 30, 70 → four requests in 90 s, not ninety.
      expect(appraise.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(appraise.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables the CTA while the quote has expired and a fresh one is on its way", async () => {
    let n = 0;
    const appraise = vi.fn(() => (n++ === 0 ? Promise.resolve(appraisal(usd(1587.5), -1)) : new Promise<AppraiseResult>(() => {})));
    wrap(<RedeemPanel c={cardFixture("sharded", 1_790_000_000)} me={PAOLO} />, { read: chainRead(), appraise });
    await waitFor(() => expect(screen.getAllByText("Getting a fresh appraisal…").length).toBeGreaterThan(0));
    for (const b of screen.getAllByRole("button", { name: /Buy out and redeem/ })) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});

function Probe() {
  const v = useVaultSuccess(1n);
  return v ? <output data-testid="success">{JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}</output> : null;
}

describe("success feedback", () => {
  it("shows the buyout success from the chain when the redeem had already landed", async () => {
    const read = chainRead({ cards: { state: 1, beneficialOwner: PAOLO }, shardings: { clearingPriceQ96: usdcPerShardToQ96(usd(1712)), buyoutPerShard: usd(1712) } });
    const send = vi.fn();
    wrap(<><RedeemPanel c={cardFixture("sharded", 1_790_000_000)} me={PAOLO} /><Probe /></>, { read, send, appraise: async () => appraisal(usd(1587.5)) });
    await waitFor(() => expect(screen.getAllByText("$5,264.40").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /Buy out and redeem/ }));
    const out = await screen.findByTestId("success", {}, { timeout: 3000 });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.parse(out.textContent!)).toMatchObject({ kind: "redeemed", buyoutPerShard: usd(1712).toString(), payoutUsdc: usd(5136).toString(), feeUsdc: usd(128.4).toString() });
  });

  it("confirms a payout with the tx link even when PayoutClaimed can't be read", async () => {
    const send = vi.fn<(i: SendInput) => Promise<Sent>>(async () => sent());
    const onClaimed = vi.fn();
    wrap(<PayoutPanel me={KENJI} cardName="Black Lotus" onClaimed={onClaimed} sharding={{ cardId: 1n, shardToken: TOKEN, buyoutPerShard: usd(1840), redeemer: PAOLO }} />, { read: chainRead({ balanceOf: S }), send });
    fireEvent.click(await screen.findByRole("button", { name: "Claim $1,840.00" }));
    await waitFor(() => expect(onClaimed).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(onClaimed.mock.calls[0][0]).toMatchObject({ kind: "claimed", usdc: usd(1840), shardUnits: S, hash: `0x${"1".repeat(64)}` });
  });

  it("fills Max with the exact balance", async () => {
    wrap(<SendShardsSheet open onOpenChange={() => {}} cardName="Black Lotus" shardToken={TOKEN} balance={1234567890123456789012n} supply={2000n * S} />, { read: chainRead() });
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect((screen.getByDisplayValue("1234.567890123456789012") as HTMLInputElement).value).toBe("1234.567890123456789012");
  });
});
