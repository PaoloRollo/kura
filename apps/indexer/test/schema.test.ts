import { describe, expect, it } from "vitest";
import * as schema from "../ponder.schema";

const cols = (table: object) => Object.keys(table);

// drizzle-orm is not a direct dependency, so read index definitions through drizzle's table symbols.
const indexedColumns = (table: object): string[][] => {
  const t = table as Record<symbol, unknown>;
  const build = t[Symbol.for("drizzle:ExtraConfigBuilder")] as ((c: unknown) => Record<string, { config: { columns: { name: string }[] } }>) | undefined;
  if (!build) return [];
  return Object.values(build(t[Symbol.for("drizzle:ExtraConfigColumns")])).map((i) => i.config.columns.map((c) => c.name));
};

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
  it("lets collector resolver records be scoped by resolver and node", () => {
    expect(cols(schema.collectors)).toEqual(expect.arrayContaining(["resolver", "node"]));
    expect(indexedColumns(schema.collectors)).toContainEqual(["resolver"]);
  });
  it("orders activities by a required integer logIndex for stable sorting", () => {
    expect(cols(schema.activities)).toContain("logIndex");
    const logIndex = (schema.activities as unknown as Record<string, { notNull: boolean; columnType: string }>).logIndex;
    expect(logIndex.notNull).toBe(true);
    expect(logIndex.columnType).toBe("PgInteger");
  });
});
