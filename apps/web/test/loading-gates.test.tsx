// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ address: null }), apiFetch: vi.fn() }));
vi.mock("@/lib/tx", async () => ({ ...(await vi.importActual<object>("@/lib/tx-core")), useSendTx: () => ({ send: vi.fn(), walletKind: "embedded" }), getReceipt: async () => null }));
vi.mock("@ponder/react", () => ({ usePonderQuery: () => ({ data: [], isSuccess: true }) }));

import { MyShardsView } from "@/components/my-shards-view";
import { RedeemPage, RedeemPanel } from "@/components/redeem-panel";
import { VaultIoContext, type VaultIo } from "@/components/vault-io";
import { HandlesFixture } from "@/hooks/use-handles";
import { HANDLES, PAOLO, cardFixture } from "@/app/design/card/fixtures";

afterEach(cleanup);

// Chain reads that never answer: the live read is still in flight.
const pending: Partial<VaultIo> = { read: () => new Promise(() => {}), appraise: vi.fn() };

function wrap(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <HandlesFixture.Provider value={HANDLES}>
        <VaultIoContext.Provider value={pending}>{ui}</VaultIoContext.Provider>
      </HandlesFixture.Provider>
    </QueryClientProvider>,
  );
}

const sharded = () => cardFixture("sharded", 1_790_000_000);

describe("loading gates", () => {
  it("My shards shows a skeleton, not 'you don't hold shards', while shardings load", () => {
    const c = { ...sharded(), sharding: null, allShardings: [], shardingsLoading: true };
    wrap(<MyShardsView c={c} me={PAOLO} now={0} block={1n} binding={null} feeBps={250} />);
    expect(screen.queryByText(/don.t hold shards/)).toBeNull();
    expect(screen.getByLabelText("Loading your shards")).toBeTruthy();
  });

  it("My shards waits for the live read or the token's holders before saying I hold none", () => {
    const c = { ...sharded(), myBalance: 0n, holders: [], holdersLoading: true };
    wrap(<MyShardsView c={c} me={PAOLO} now={0} block={1n} binding={null} feeBps={250} />);
    expect(screen.queryByText(/don.t hold shards/)).toBeNull();
    expect(screen.getByLabelText("Loading your shards")).toBeTruthy();
  });

  it("the redeem page shows a skeleton, not 'this card isn't sharded', while shardings load", () => {
    const c = { ...sharded(), sharding: null, allShardings: [], shardingsLoading: true };
    wrap(<RedeemPage c={c} me={PAOLO} identity={{ name: "Black Lotus", image: null }} />);
    expect(screen.queryByText(/isn.t sharded/)).toBeNull();
    expect(screen.getByLabelText("Fetching the appraisal")).toBeTruthy();
  });

  it("the redeem panel shows a skeleton, not its fallback, while the token's holders load", () => {
    const c = { ...sharded(), myBalance: 0n, holders: [], holdersLoading: true };
    wrap(<RedeemPanel c={c} me={PAOLO} fallback={<p>not a holder</p>} />);
    expect(screen.queryByText("not a holder")).toBeNull();
    expect(screen.getByLabelText("Fetching the appraisal")).toBeTruthy();
  });
});
