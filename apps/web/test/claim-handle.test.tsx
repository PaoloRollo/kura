// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClaimHandleView } from "@/components/claim-handle";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
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
