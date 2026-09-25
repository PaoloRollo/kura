import { describe, expect, it } from "vitest";
import * as schema from "../ponder.schema";

const cols = (table: object) => Object.keys(table);

describe("schema", () => {
  it("persists bid state only as status", () => {
    expect(cols(schema.bids)).toContain("status");
    expect(cols(schema.bids)).not.toContain("exited");
    expect(cols(schema.bids)).not.toContain("claimed");
  });
  it("stores block and time on every row", () => {
    expect(cols(schema.activeAuctions)).toEqual(expect.arrayContaining(["blockNumber", "timestamp", "startBlock"]));
    expect(cols(schema.ensNames)).toEqual(expect.arrayContaining(["updatedBlock", "updatedAt"]));
    expect(cols(schema.collectors)).toEqual(expect.arrayContaining(["blockNumber", "registeredAt"]));
    expect(cols(schema.bidderBindings)).toEqual(expect.arrayContaining(["blockNumber", "boundAt"]));
  });
});
