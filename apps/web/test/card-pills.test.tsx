// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CardPills } from "@/components/card-header";

afterEach(cleanup);

const card = { state: "auctioning" as const, condition: "NM", language: "en" };
const identity = { name: "Black Lotus", image: null, artist: null };
const sharding = { endBlock: 100n, settled: false };

describe("CardPills", () => {
  it("says the auction is live before its end block", () => {
    render(<CardPills card={card} identity={identity} sharding={sharding} block={99n} />);
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("says ended, awaiting settle once the end block is reached and it isn't settled", () => {
    render(<CardPills card={card} identity={identity} sharding={sharding} block={100n} />);
    expect(screen.getByText("Ended · awaiting settle")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("stays live while the block is unknown", () => {
    render(<CardPills card={card} identity={identity} sharding={sharding} block={null} />);
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("says how a settled auction ended, not 'sharded'", () => {
    render(<CardPills card={{ ...card, state: "sharded" }} identity={identity} sharding={{ ...sharding, settled: true, graduated: true }} block={200n} />);
    expect(screen.getByText("Ended · sold")).toBeTruthy();
    cleanup();
    render(<CardPills card={{ ...card, state: "sharded" }} identity={identity} sharding={{ ...sharding, settled: true, graduated: false }} block={200n} />);
    expect(screen.getByText("Ended · reserve not met")).toBeTruthy();
  });
});
