// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClaimHandleView } from "@/components/claim-handle";

afterEach(cleanup);

const base = { holding: null, fallbackName: "0x4f2c…a81e", hints: [], cta: <button type="button">cta</button> };

describe("ClaimHandleView", () => {
  it("shows an available handle with its preview and top holding", () => {
    render(<ClaimHandleView {...base} label="paolo" onLabel={() => {}} check={{ available: true }} holding={{ card: "Black Lotus", shards: "13", pct: "81.3%" }} />);
    expect(screen.getByText("Available · 3 to 32 lowercase letters or digits, no dashes")).toBeTruthy();
    expect(screen.getByText("paolo.kura.eth")).toBeTruthy();
    expect(screen.getByText("holds 13 shards of Black Lotus")).toBeTruthy();
    expect(screen.getByLabelText("Available")).toBeTruthy();
  });

  it("explains a taken handle and a wallet without shards", () => {
    render(<ClaimHandleView {...base} label="kenji" onLabel={() => {}} check={{ available: false, reason: "TAKEN" }} />);
    expect(screen.getByText("kenji.kura.eth is taken")).toBeTruthy();
    expect(screen.getByText("holds no shards yet")).toBeTruthy();
  });

  it("lowercases what is typed and drops spaces", () => {
    const onLabel = vi.fn();
    render(<ClaimHandleView {...base} label="" onLabel={onLabel} check={null} />);
    fireEvent.change(screen.getByLabelText("Your Kura handle"), { target: { value: "Pa olo" } });
    expect(onLabel).toHaveBeenCalledWith("paolo");
    expect(screen.getByText("0x4f2c…a81e")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Container

const ME = "0x00000000000000000000000000000000000000aa";
const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const state = vi.hoisted(() => ({ handles: {} as Record<string, string>, send: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/hooks/use-handles", () => ({ useHandlesState: () => ({ handles: state.handles, ready: true }) }));
vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ address: ME }) }));
vi.mock("@/hooks/use-vendor-data", () => ({ useCardMetas: () => new Map() }));
vi.mock("@ponder/react", () => ({ usePonderQuery: () => ({ data: undefined }) }));
vi.mock("@/lib/tx", async () => ({ ...(await vi.importActual<object>("@/lib/tx-core")), useSendTx: () => ({ send: state.send }), getReceipt: async () => null }));
vi.mock("@/lib/tx-core", async (orig) => ({ ...(await orig<object>()), syncAfterTx: async () => ({ indexed: true, late: Promise.resolve(true) }) }));
vi.mock("@/lib/chain", async (orig) => ({ ...(await orig<object>()), publicClient: { readContract: async () => "" } }));

import { waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClaimHandle } from "@/components/claim-handle";
import { TxError } from "@/lib/tx-core";

function renderContainer() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ClaimHandle />
    </QueryClientProvider>,
  );
}

describe("ClaimHandle", () => {
  beforeEach(() => {
    nav.push.mockReset();
    nav.replace.mockReset();
    state.handles = {};
    state.send = vi.fn();
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as never;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ available: true }))));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function typeAndWait(label: string) {
    fireEvent.change(screen.getByLabelText("Your Kura handle"), { target: { value: label } });
    await waitFor(() => expect(screen.getByLabelText("Available")).toBeTruthy());
  }

  it("claims the handle with registerCollector, then goes to /app", async () => {
    state.send.mockResolvedValue({ hash: "0x01", receipt: { status: "success", blockNumber: 5n } });
    renderContainer();
    await typeAndWait("paolo");
    fireEvent.click(screen.getByRole("button", { name: "Claim paolo.kura.eth" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/app"));
    expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ functionName: "registerCollector", args: ["paolo"] }));
    expect(String((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0])).toContain(`address=${ME}`);
  });

  it("sends a wallet that already has a handle back to /app", async () => {
    state.handles = { [ME]: "paolo" };
    renderContainer();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/app"));
  });

  it("turns a HandleTaken revert into the field's message and offers only to edit the handle", async () => {
    state.send.mockRejectedValue(new TxError("reverted", { name: "HandleTaken" }));
    renderContainer();
    await typeAndWait("kenji");
    fireEvent.click(screen.getByRole("button", { name: "Claim kenji.kura.eth" }));
    await waitFor(() => expect(screen.getAllByText("kenji.kura.eth is taken").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit handle" }));
    expect((screen.getByRole("button", { name: "Claim kenji.kura.eth" }) as HTMLButtonElement).disabled).toBe(true);
    expect(nav.push).not.toHaveBeenCalled();
  });
});
