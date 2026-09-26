// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  send: vi.fn(),
  readState: 1,
  pending: null as unknown,
  gate: null as null | Record<string, unknown>,
}));

vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ address: "0x7aD58bd97A7cd456dC854B1cEc95eC80f6F4F9fe", identityToken: "tok", isVendor: true }), apiFetch: h.apiFetch }));
vi.mock("@/lib/tx", async () => ({ ...(await vi.importActual<object>("@/lib/tx-core")), useSendTx: () => ({ send: h.send, walletKind: "external" }), getReceipt: async () => null }));
vi.mock("@ponder/react", () => ({ usePonderQuery: () => ({ data: [], isSuccess: true }) }));
vi.mock("@/components/world-id-gate", async () => ({
  ...(await vi.importActual<object>("@/components/world-id-gate")),
  // The modal gate is IDKit's; here it records its props and "verifies" on click.
  WorldIdGate: (p: Record<string, unknown>) => {
    h.gate = p;
    return (
      <button type="button" onClick={() => (p.onReleaseReady as (r: unknown) => void)({ ok: true, ticketId: "t1", cardId: "1", expiresAt: String(Math.floor(Date.now() / 1000) + 899), credential: "passport" })}>
        {p.label as string}
      </button>
    );
  },
}));
Object.defineProperty(window, "matchMedia", { value: (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }) });

import { releaseRefusal } from "@/components/collect-at-counter";
import { OwnerPanel } from "@/components/card-state-panel";
import { ReleasePanel } from "@/components/release-panel";
import { InventoryView, type InventoryItem } from "@/components/vendor/inventory";
import { worldIdErrorMessage, worldIdRefusalTitle } from "@/components/world-id-gate";
import type { CardData } from "@/hooks/use-card";
import { addresses, publicClient } from "@/lib/chain";
import { matchCode } from "@/lib/release";

const HOLDER = "0xDeADaD159DF0923dAF871f8B4740eD7f7F417ee9" as const;
const NOW = Math.floor(Date.now() / 1000);
const PENDING = { id: "t1", ticket: { kind: 2, subject: HOLDER, nullifier: "42", expiresAt: String(NOW + 900) }, signature: "0xabcd" };
const HASH = `0x${"7".repeat(64)}` as const;
const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};
const panel = (extra: Partial<React.ComponentProps<typeof ReleasePanel>> = {}) =>
  wrap(<ReleasePanel cardId={1n} holder={HOLDER} card={{ name: "Black Lotus", ensName: "black-lotus-lea-1.kura.eth" }} redeemedAt={NOW - 12 * 60} onClose={() => {}} {...extra} />);

beforeEach(() => {
  h.readState = 1;
  h.pending = null;
  h.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/release/pending")) return res(200, { pending: h.pending });
    if (path === "/api/release/consume") return res(200, { consumed: true });
    if (path.startsWith("/api/release/ticket")) return res(200, init?.method === "DELETE" ? { cancelled: true } : { ready: null });
    return res(404, {});
  });
  h.send.mockResolvedValue({ hash: HASH, receipt: { status: "success", blockNumber: 5n, logs: [], transactionHash: HASH } });
  vi.spyOn(publicClient, "readContract").mockImplementation((async () => ({ state: h.readState })) as never);
  vi.stubGlobal("fetch", vi.fn(async () => res(200, { sepolia: { block: { number: 99 } } })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const consumed = () => h.apiFetch.mock.calls.filter(([p]) => p === "/api/release/consume").map(([, i]) => JSON.parse((i as RequestInit).body as string).id);

describe("vendor ReleasePanel", () => {
  it("waits for the owner's own check, then confirms the release and marks the ticket used", async () => {
    const onReleased = vi.fn();
    panel({ onReleased });
    expect(await screen.findByText(/Ask the holder to open the card in Kura and tap Collect at the counter/)).toBeTruthy();
    expect(screen.getByText(/Only the card's owner can start this, from their own Kura app/)).toBeTruthy();
    expect(screen.queryByRole("img", { name: /QR/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Confirm handover/ }).hasAttribute("disabled")).toBe(true);
    // The station polls the vendor-only route for this card.
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/api/release/pending?cardId=1", expect.objectContaining({ identityToken: "tok" })));

    h.pending = { ...PENDING, ticket: { ...PENDING.ticket, subject: "0x4f2c6e1a0b3d5f7a9c1e3b5d7f9a1c3e5b7da81e" } };
    expect(await screen.findByText("Passport verified", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/Release ticket signed · valid 1[45]:\d\d/)).toBeTruthy();
    // The name comes from the ticket's subject, not the indexer's holder.
    expect(screen.getByText("0x4f2c…a81e")).toBeTruthy();
    expect(screen.getByText(matchCode("t1"))).toBeTruthy();
    expect(screen.getByText("Check the holder's screen shows the same code")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Confirm handover/ }));
    expect(await screen.findByText("Handover confirmed", {}, { timeout: 5000 })).toBeTruthy();
    expect(h.send).toHaveBeenCalledWith({
      to: addresses.cardVault,
      abi: expect.anything(),
      functionName: "confirmRelease",
      args: [1n, { kind: 2, subject: "0x4f2c6e1a0b3d5f7a9c1e3b5d7f9a1c3e5b7da81e", nullifier: 42n, expiresAt: BigInt(NOW + 900) }, "0xabcd"],
    });
    expect(consumed()).toEqual(["t1"]);
    expect(onReleased).toHaveBeenCalled();
  });

  it("marks a spent ticket used and offers one way on", async () => {
    const { TxError } = await import("@/lib/tx-core");
    h.send.mockRejectedValueOnce(new TxError("reverted", { name: "TicketUsed" }));
    h.pending = PENDING;
    panel();
    await screen.findByText("Passport verified", {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: /Confirm handover/ }));
    expect(await screen.findByText("This ticket was already used")).toBeTruthy();
    await waitFor(() => expect(consumed()).toEqual(["t1"]));
    // One CTA: no Retry beside it.
    expect(screen.getByRole("button", { name: "Wait for a new check" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("does not offer Retry for an expired ticket", async () => {
    const { TxError } = await import("@/lib/tx-core");
    h.send.mockRejectedValueOnce(new TxError("reverted", { name: "Expired" }));
    h.pending = PENDING;
    panel();
    await screen.findByText("Passport verified", {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: /Confirm handover/ }));
    expect(await screen.findByText("The release ticket expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("does not send again once the vault shows the card released", async () => {
    h.readState = 4;
    h.pending = PENDING;
    panel();
    await screen.findByText("Passport verified", {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: /Confirm handover/ }));
    expect(await screen.findByText("Handover confirmed", {}, { timeout: 5000 })).toBeTruthy();
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("InventoryView", () => {
  const item = (state: InventoryItem["state"]): InventoryItem => ({ id: 1n, name: "Black Lotus", set: "LEA", condition: "NM", ensName: "black-lotus-lea-1.kura.eth", state, owner: HOLDER, awaiting: true });
  const stats = { inCustody: 1, feesTotal: 0n, feesWeek: 0n, awaiting: 1, released: 0 };

  it("keeps the handover confirmation when the row flips to released mid-indexing", async () => {
    h.pending = PENDING;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The indexer catches up while the stepper is still indexing: the row turns released before onDone.
    let flip: () => void = () => {};
    function Harness() {
      const [items, setItems] = React.useState([item("whole")]);
      flip = () => setItems([item("released")]);
      return <InventoryView items={items} stats={stats} tab="all" onTab={() => {}} initialSelected={1n} />;
    }
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (calls++ === 0) flip();
      return res(200, { sepolia: { block: { number: 99 } } });
    }));
    render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>);
    await screen.findByText("Passport verified", {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: /Confirm handover/ }));
    expect(await screen.findByText("Handover confirmed", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("released")).toBeTruthy();
  });
});

describe("owner's Collect at the counter", () => {
  const card = { id: 1n, state: "whole", ownerOf: HOLDER, beneficialOwner: HOLDER } as unknown as NonNullable<CardData["card"]>;
  const c = { card, price: null } as unknown as CardData;

  it("runs the Passport check for the owner's own card and shows the ticket to the vendor, cancellable", async () => {
    wrap(<OwnerPanel c={c} name="Black Lotus" />);
    fireEvent.click(screen.getByRole("button", { name: /Collect at the counter/ }));
    expect(h.gate).toMatchObject({ action: "release", signal: HOLDER, cardId: 1n });
    fireEvent.click(await screen.findByRole("button", { name: "Verify with Passport" }));
    expect(await screen.findByText("Show this to the vendor")).toBeTruthy();
    expect(screen.getByText(/ready for 14:5\d/)).toBeTruthy();
    // The same code the vendor's station shows for ticket t1.
    expect(screen.getByText(matchCode("t1"))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/api/release/ticket?cardId=1", expect.objectContaining({ method: "DELETE" })));
    expect(await screen.findByRole("button", { name: /Collect at the counter/ })).toBeTruthy();
  });

  it("restores a waiting ticket on reload", async () => {
    h.apiFetch.mockImplementation(async () => res(200, { ready: { id: "t1", cardId: "1", expiresAt: String(NOW + 600) } }));
    wrap(<OwnerPanel c={c} name="Black Lotus" />);
    expect(await screen.findByText("Show this to the vendor")).toBeTruthy();
  });

  it("notices when the vendor used the ticket and offers to verify again", async () => {
    let ready: unknown = { id: "t1", cardId: "1", expiresAt: String(NOW + 600) };
    h.apiFetch.mockImplementation(async () => res(200, { ready }));
    wrap(<OwnerPanel c={c} name="Black Lotus" />);
    expect(await screen.findByText("Show this to the vendor")).toBeTruthy();
    ready = null; // consumed at the counter
    expect(await screen.findByText("Your check ended", {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Verify again/ })).toBeTruthy();
  }, 15_000);

  it("names the wallet a Passport is already linked to", () => {
    expect(releaseRefusal("ALREADY_BOUND", { boundTo: "0x1111111111111111111111111111111111111111" })).toBe(
      "Your Passport is linked to 0x1111…1111. Collect from that wallet, or move the card to it first.",
    );
    expect(releaseRefusal("NOT_OWNER")).toBe("Only the card's owner can collect it, from their own Kura app.");
  });
});

describe("World ID refusal copy", () => {
  it("says who refused, in plain words", () => {
    expect(worldIdRefusalTitle("WORLD_REJECTED")).toBe("World refused the verification");
    expect(worldIdRefusalTitle("user_rejected")).toBe("World refused the verification");
    for (const code of ["VERIFY_FAILED", "FORBIDDEN", "CONFIG", "NOT_OWNER", "CARD_NOT_WHOLE", "INTERNAL"]) {
      expect(worldIdRefusalTitle(code)).toBe("Kura refused the verification");
      expect(worldIdErrorMessage(code)).not.toMatch(/Verification [A-Z_]+/);
    }
    expect(worldIdErrorMessage("NOT_OWNER")).toBe("Only the card's owner can collect it, from their own Kura app.");
    expect(worldIdErrorMessage("SOMETHING_NEW")).toBe("Verification failed. Try again.");
  });
});
