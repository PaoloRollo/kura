// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  open: vi.fn(),
  reset: vi.fn(),
  push: null as null | ((s: Record<string, unknown>) => void),
  config: null as null | Record<string, unknown>,
  apiFetch: vi.fn(),
  send: vi.fn(),
  readState: 1,
}));

vi.mock("@worldcoin/idkit", () => ({
  passport: (o: unknown) => ({ type: "passport", ...(o as object) }),
  useIDKitRequest: (config: Record<string, unknown>) => {
    const [s, set] = React.useState<Record<string, unknown>>({ isSuccess: false, result: null, isError: false, errorCode: null, connectorURI: null, isAwaitingUserConfirmation: false });
    h.push = (next) => set((prev) => ({ ...prev, ...next }));
    h.config = config;
    return { ...s, open: h.open, reset: h.reset };
  },
}));
vi.mock("@/env", () => ({ publicEnv: () => ({ NEXT_PUBLIC_WORLD_APP_ID: "app_test", NEXT_PUBLIC_WORLD_ENV: "staging" }) }));
vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ address: "0x7aD58bd97A7cd456dC854B1cEc95eC80f6F4F9fe", identityToken: "tok", isVendor: true }), apiFetch: h.apiFetch }));
vi.mock("@/lib/tx", async () => ({ ...(await vi.importActual<object>("@/lib/tx-core")), useSendTx: () => ({ send: h.send, walletKind: "external" }), getReceipt: async () => null }));
vi.mock("@ponder/react", () => ({ usePonderQuery: () => ({ data: [], isSuccess: true }) }));
Object.defineProperty(window, "matchMedia", { value: (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }) });

import { ReleasePanel } from "@/components/release-panel";
import { addresses, publicClient } from "@/lib/chain";

const HOLDER = "0xDeADaD159DF0923dAF871f8B4740eD7f7F417ee9" as const;
const NOW = Math.floor(Date.now() / 1000);
const TICKET = { ticket: { kind: 2, subject: HOLDER, nullifier: "42", expiresAt: String(NOW + 900) }, signature: "0xabcd", credential: "passport" };
const HASH = `0x${"7".repeat(64)}` as const;
const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

function renderPanel(extra: Partial<React.ComponentProps<typeof ReleasePanel>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReleasePanel cardId={1n} holder={HOLDER} card={{ name: "Black Lotus", ensName: "black-lotus-lea-1.kura.eth" }} redeemedAt={NOW - 12 * 60} onClose={() => {}} {...extra} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.readState = 1;
  h.apiFetch.mockImplementation(async (path: string) =>
    path === "/api/worldid/rp-context" ? res(200, { rp_id: "rp_1", nonce: "n", created_at: NOW, expires_at: NOW + 300, signature: "0xs" }) : res(200, TICKET),
  );
  h.send.mockResolvedValue({ hash: HASH, receipt: { status: "success", blockNumber: 5n, logs: [], transactionHash: HASH } });
  vi.spyOn(publicClient, "readContract").mockImplementation((async () => ({ state: h.readState })) as never);
  vi.stubGlobal("fetch", vi.fn(async () => res(200, { sepolia: { block: { number: 99 } } })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function verifyHolder() {
  fireEvent.click(screen.getByRole("button", { name: /Start Passport check/ }));
  await waitFor(() => expect(h.open).toHaveBeenCalled());
  // The request opened with the rp context and a Passport preset bound to the holder.
  expect(h.config).toMatchObject({ action: "release", rp_context: { nonce: "n" }, preset: { type: "passport", signal: HOLDER } });
  act(() => h.push!({ connectorURI: "https://world.org/verify?t=wld&i=abc" }));
  expect(await screen.findByText(/Waiting for Passport verification/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /Confirm handover/ }).hasAttribute("disabled")).toBe(true);
  act(() => h.push!({ isSuccess: true, result: { action: "release", responses: [{ signal_hash: "0x" }] } }));
  expect(await screen.findByText("Passport verified")).toBeTruthy();
}

describe("ReleasePanel", () => {
  it("runs the Passport check, then confirms the release from the vendor wallet", async () => {
    const onReleased = vi.fn();
    renderPanel({ onReleased });
    expect(screen.getByText(/Redeemed 12 min ago/)).toBeTruthy();
    await verifyHolder();

    // One verify path: the shared hook posted the IDKit result with the holder as subject.
    const verifyCall = h.apiFetch.mock.calls.find(([p]) => p === "/api/worldid/verify")!;
    expect(JSON.parse(verifyCall[1].body)).toMatchObject({ action: "release", subject: HOLDER });
    expect(screen.getByText(/Release ticket signed · valid 1[45]:\d\d/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Confirm handover/ }));
    expect(await screen.findByText("Handover confirmed", {}, { timeout: 5000 })).toBeTruthy();
    expect(h.send).toHaveBeenCalledWith({
      to: addresses.cardVault,
      abi: expect.anything(),
      functionName: "confirmRelease",
      args: [1n, { kind: 2, subject: HOLDER, nullifier: 42n, expiresAt: BigInt(NOW + 900) }, "0xabcd"],
    });
    expect(onReleased).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /0x777…777/ }).getAttribute("href")).toContain(HASH);
  });

  it("shows World's refusal with a retry", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Start Passport check/ }));
    await waitFor(() => expect(h.open).toHaveBeenCalled());
    act(() => h.push!({ isError: true, errorCode: "user_rejected" }));
    expect(await screen.findByText("The holder declined in World App.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
  });

  it("maps a spent ticket to a new Passport check", async () => {
    const { TxError } = await import("@/lib/tx-core");
    h.send.mockRejectedValueOnce(new TxError("reverted", { name: "TicketUsed" }));
    renderPanel();
    await verifyHolder();
    fireEvent.click(screen.getByRole("button", { name: /Confirm handover/ }));
    expect(await screen.findByText("This ticket was already used")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Start a new Passport check/ })).toBeTruthy();
  });

  it("does not send again once the vault shows the card released", async () => {
    h.readState = 4;
    renderPanel();
    await verifyHolder();
    fireEvent.click(screen.getByRole("button", { name: /Confirm handover/ }));
    expect(await screen.findByText("Handover confirmed", {}, { timeout: 5000 })).toBeTruthy();
    expect(h.send).not.toHaveBeenCalled();
  });
});
