// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const ME = "0x00000000000000000000000000000000000000aa";
const state = vi.hoisted(() => ({ wallets: [] as { address: string; walletClientType: string }[], address: null as string | null }));

vi.mock("@privy-io/react-auth", () => ({ useSendTransaction: () => ({ sendTransaction: vi.fn() }), useWallets: () => ({ wallets: state.wallets }) }));
vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ address: state.address }) }));

import { useSendTx } from "@/lib/tx";

describe("useSendTx walletKind", () => {
  it("is embedded for the Privy embedded wallet", () => {
    state.address = ME;
    state.wallets = [{ address: ME, walletClientType: "privy" }];
    expect(renderHook(() => useSendTx()).result.current.walletKind).toBe("embedded");
  });

  it("is external for any other wallet (the vendor's Rabby)", () => {
    state.address = ME;
    state.wallets = [{ address: ME.toUpperCase().replace("0X", "0x"), walletClientType: "rabby_wallet" }];
    expect(renderHook(() => useSendTx()).result.current.walletKind).toBe("external");
  });

  it("is null when the identity wallet isn't connected", () => {
    state.address = ME;
    state.wallets = [];
    expect(renderHook(() => useSendTx()).result.current.walletKind).toBeNull();
  });
});
