// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { getAddress, isAddress } from "viem";

vi.mock("@/hooks/use-handles", () => ({ useHandles: () => ({}), useDisplayName: (a: string) => a, useHandlesState: () => ({ handles: {}, ready: true }) }));

import { ProfileView, collectorQrPayload } from "@/components/profile-view";
import { HandleBanner } from "@/components/handle-banner";
import { PortfolioView } from "@/components/portfolio-view";
import type { PortfolioData } from "@/hooks/use-portfolio";

afterEach(cleanup);

const ME = "0x4f2c000000000000000000000000000000a81eab" as const;

describe("collector QR", () => {
  it("encodes exactly the checksummed address, which the station scanner accepts", () => {
    const payload = collectorQrPayload(ME);
    expect(payload).toBe(getAddress(ME));
    // The station's QrScanner: trim, strip "ethereum:", isAddress (strict checksum), then getAddress.
    expect(isAddress(payload)).toBe(true);
  });

  it("shows the QR with the handle under it on the profile", () => {
    render(<ProfileView me={ME} handle="paolo.kura.eth" usdc={0n} verified={false} wallet="Embedded · Privy" embedded onLogout={() => {}} />);
    const qr = screen.getByRole("img", { name: /collector QR/i });
    expect(qr.getAttribute("data-payload")).toBe(getAddress(ME));
    expect(document.getElementById("qr")?.textContent).toContain("paolo.kura.eth");
  });

  it("links to it from the claim-handle banner and the empty portfolio", () => {
    render(<HandleBanner forceShow />);
    expect(screen.getByRole("link", { name: /show my qr/i }).getAttribute("href")).toBe("/app/profile#qr");
    cleanup();
    const d = {
      me: ME, holdings: [], whole: [], released: [], bids: { live: [], ended: [] }, payouts: [], allocation: [],
      totals: { value: 0n, gain: 0n, cards: 0 }, usdc: 0n, verified: false, handle: null, block: 1n, isLoading: false,
    } as unknown as PortfolioData;
    render(<PortfolioView d={d} tab="shards" onTab={() => {}} />);
    expect(screen.getByRole("link", { name: /show my qr/i }).getAttribute("href")).toBe("/app/profile#qr");
  });
});
