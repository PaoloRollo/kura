// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { HandlesFixture } from "@/hooks/use-handles";
import type { AppraiseResult } from "@/lib/appraise";
import { buyoutQuote, dropsBelowThreshold, payoutFor, shardsShort } from "@/lib/buyout";
import { addresses } from "@/lib/chain";
import type { SendInput, Sent } from "@/lib/tx-core";
import { HANDLES, KENJI, PAOLO, cardFixture } from "@/app/design/card/fixtures";

afterEach(cleanup);
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

const appraisal = (usdcPerShard: bigint): AppraiseResult => ({
  appraisal: { cardId: "1", shardToken: TOKEN, usdcPerShard: usdcPerShard.toString(), expiresAt: String(Math.floor(Date.now() / 1000) + 600) },
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
