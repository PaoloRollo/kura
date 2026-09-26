import { describe, expect, it } from "vitest";
import { cardStatus } from "@/lib/card-status";

const s = (over: { endBlock?: bigint; settled?: boolean; graduated?: boolean | null } = {}) => ({ endBlock: 100n, settled: false, graduated: null, ...over });

describe("cardStatus", () => {
  it("reads a live auction as Live until its end block, then Ended · awaiting settle", () => {
    expect(cardStatus({ state: "auctioning" }, s(), 99n)).toMatchObject({ key: "live", label: "Live", tone: "live" });
    expect(cardStatus({ state: "auctioning" }, s(), 100n)).toMatchObject({ key: "awaiting", label: "Ended · awaiting settle", short: "ended, awaiting settle" });
    // Unknown block or sharding: still live.
    expect(cardStatus({ state: "auctioning" }, s(), null).key).toBe("live");
    expect(cardStatus({ state: "auctioning" }, null, 500n).key).toBe("live");
  });

  it("reads a settled auction by how it ended", () => {
    expect(cardStatus({ state: "sharded" }, s({ settled: true, graduated: true }), 200n)).toMatchObject({ label: "Ended · sold", short: "ended, sold", tone: "sharded" });
    expect(cardStatus({ state: "sharded" }, s({ settled: true, graduated: false }), 200n)).toMatchObject({ label: "Ended · reserve not met", tone: "neutral" });
    // The card row can lag its sharding: settled wins over "auctioning".
    expect(cardStatus({ state: "auctioning" }, s({ settled: true, graduated: true }), 200n).key).toBe("sold");
    expect(cardStatus({ state: "sharded" }, null, 200n).label).toBe("Ended");
  });

  it("leaves whole and released cards as they are", () => {
    expect(cardStatus({ state: "whole" }, null, 1n)).toMatchObject({ label: "Whole", tone: "neutral" });
    expect(cardStatus({ state: "released" }, s({ graduated: true }), 1n)).toMatchObject({ label: "Released", tone: "released" });
  });
});
