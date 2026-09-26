import { describe, expect, it } from "vitest";
import * as schema from "../ponder.schema";

const cols = (table: object) => Object.keys(table);
// Column keys only (drizzle tables also carry an enableRLS method).
const columnsOf = (table: object) => cols(table).filter((k) => k !== "enableRLS").sort();

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

  it("stores one pool per card with its price, seed, volume, fee and freeze state", () => {
    expect(columnsOf(schema.pools)).toEqual([
      "cardId", "poolId", "shardToken", "shardIsCurrency0", "sqrtPriceX96", "priceUsdcPerShard", "seededAt", "seedShards",
      "seedUsdc", "lastSwapAt", "swapCount", "volumeUsdc", "frozen", "lpOwner", "feesShards", "feesUsdc",
    ].sort());
    const c = schema.pools as unknown as Record<string, { notNull: boolean; primary: boolean; columnType: string }>;
    expect(c.cardId!.primary).toBe(true);
    expect(c.lastSwapAt!.notNull).toBe(false);
    expect(c.swapCount!.columnType).toBe("PgInteger");
    for (const k of ["poolId", "shardToken", "sqrtPriceX96", "priceUsdcPerShard", "seededAt", "frozen", "lpOwner", "feesUsdc"]) {
      expect(c[k]!.notNull).toBe(true);
    }
  });
  it("stores swaps keyed by log, indexed by card and trader", () => {
    expect(columnsOf(schema.swaps)).toEqual([
      "id", "cardId", "trader", "side", "shardAmount", "usdcAmount", "priceUsdcPerShard", "sqrtPriceX96", "blockNumber",
      "timestamp", "txHash",
    ].sort());
    expect(indexedColumns(schema.swaps)).toEqual(expect.arrayContaining([["card_id"], ["trader"]]));
  });
  it("relates pools and swaps to their card", () => {
    expect(schema.poolsRelations).toBeDefined();
    expect(schema.swapsRelations).toBeDefined();
    expect(schema.cardsRelations).toBeDefined();
  });
  it("tags the v4 PoolManager among shard holders", () => {
    const c = schema.shardBalances as unknown as Record<string, { notNull: boolean; columnType: string }>;
    expect(c.isPool!.columnType).toBe("PgBoolean");
    expect(c.isPool!.notNull).toBe(true);
  });
  it("has activity kinds for the pool opening and swaps", () => {
    expect(schema.activityKind.enumValues).toEqual(expect.arrayContaining(["pool_opened", "swap"]));
  });
});
