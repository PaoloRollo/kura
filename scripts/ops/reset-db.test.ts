import { describe, expect, it } from "vitest";
import {
  KEPT_APP_TABLES,
  RAILWAY_DB_HOST,
  appTablesFromSchema,
  classifySchemas,
  formatPlan,
  hostRefusal,
  parseArgs,
  planReset,
  resetStatements,
} from "./reset-db";

const DEPLOY_ID = "3f2b8c1e-9a4d-4e7b-8c21-0d5e6f7a8b9c";

describe("classifySchemas", () => {
  it("drops the Ponder views schema, per-deployment schemas and the dev schema", () => {
    const { drop } = classifySchemas(["kura", DEPLOY_ID, "kura_dev", "kura_1a2b3c4d"]);
    expect(drop.map((s) => s.name)).toEqual(["kura", DEPLOY_ID, "kura_dev", "kura_1a2b3c4d"]);
  });

  it("never drops system, app, migration or Ponder sync schemas", () => {
    const names = ["public", "information_schema", "pg_catalog", "pg_toast", "pg_temp_3", "app", "drizzle", "ponder_sync"];
    const { drop, keep } = classifySchemas(names);
    expect(drop).toEqual([]);
    expect(keep.map((s) => s.name)).toEqual(names);
  });

  it("keeps anything it doesn't recognise", () => {
    const { drop, keep } = classifySchemas(["analytics", "kura-prod", "Kura", "3f2b8c1e9a4d4e7b8c210d5e6f7a8b9c", "kura_"]);
    expect(drop).toEqual([]);
    expect(keep.every((s) => /unrecognised/.test(s.reason))).toBe(true);
  });

  it("uppercase deployment ids still count", () => {
    expect(classifySchemas([DEPLOY_ID.toUpperCase()]).drop).toHaveLength(1);
  });
});

describe("app tables", () => {
  it("reads every table in the Drizzle schema, in the app schema", async () => {
    const schema = await import("../../apps/web/src/lib/db/schema");
    const tables = appTablesFromSchema(schema);
    expect(tables).toContainEqual({ schema: "app", name: "appraisals" });
    expect(tables).toContainEqual({ schema: "app", name: "release_tickets" });
    expect(tables.every((t) => t.schema === "app")).toBe(true);
    expect(new Set(tables.map((t) => t.name)).size).toBe(tables.length);
    // The kept caches really exist in the schema (a rename would silently truncate them otherwise).
    for (const k of KEPT_APP_TABLES) expect(tables.map((t) => t.name)).toContain(k.name);
  });

  it("truncates chain-bound tables, keeps the chain-independent caches unless --all-tables", () => {
    const tables = [
      { schema: "app", name: "appraisals" },
      { schema: "app", name: "market_prices" },
      { schema: "app", name: "scryfall_cache" },
      { schema: "app", name: "tickets" },
    ];
    const existing = new Set(["app.appraisals", "app.market_prices", "app.scryfall_cache"]);
    const p = planReset({ schemas: ["kura", "app", "public"], appTables: tables, existingTables: existing, allTables: false });
    expect(p.truncate.map((t) => t.name)).toEqual(["appraisals"]);
    expect(p.keepTables.map((t) => t.name)).toEqual(["market_prices", "scryfall_cache"]);
    expect(p.missingTables.map((t) => t.name)).toEqual(["tickets"]);
    const all = planReset({ schemas: [], appTables: tables, existingTables: existing, allTables: true });
    expect(all.truncate.map((t) => t.name)).toEqual(["appraisals", "market_prices", "scryfall_cache"]);
  });
});

describe("statements", () => {
  it("drops schemas with CASCADE and truncates in one statement, quoting identifiers", () => {
    const p = planReset({
      schemas: ["kura", DEPLOY_ID, "public"],
      appTables: [{ schema: "app", name: "appraisals" }, { schema: "app", name: "tickets" }],
      existingTables: new Set(["app.appraisals", "app.tickets"]),
      allTables: false,
    });
    expect(resetStatements(p)).toEqual([
      `DROP SCHEMA "kura" CASCADE`,
      `DROP SCHEMA "${DEPLOY_ID}" CASCADE`,
      `TRUNCATE "app"."appraisals", "app"."tickets" RESTART IDENTITY CASCADE`,
    ]);
  });

  it("emits nothing to truncate when no app table exists", () => {
    const p = planReset({ schemas: ["kura_dev"], appTables: [{ schema: "app", name: "x" }], existingTables: new Set(), allTables: false });
    expect(resetStatements(p)).toEqual([`DROP SCHEMA "kura_dev" CASCADE`]);
  });

  it("the plan printout names what is dropped, truncated and kept", () => {
    const p = planReset({ schemas: ["kura", "public"], appTables: [{ schema: "app", name: "market_prices" }], existingTables: new Set(["app.market_prices"]), allTables: false });
    const text = formatPlan(p, "iriguchi.proxy.rlwy.net");
    expect(text).toMatch(/DROP SCHEMA\s+kura/);
    expect(text).toMatch(/keep\s+public/);
    expect(text).toMatch(/keep\s+app\.market_prices/);
  });

  it("collapses the pg_* system schemas into one line", () => {
    const p = planReset({ schemas: ["pg_catalog", "pg_toast", "pg_temp_1", "pg_toast_temp_1", "public"], appTables: [], existingTables: new Set(), allTables: false });
    const text = formatPlan(p, "h");
    expect(text).not.toMatch(/pg_toast_temp_1/);
    expect(text).toMatch(/keep\s+pg_\*\s+\(4 system schemas\)/);
  });
});

describe("guards", () => {
  it("never applies by default", () => {
    expect(parseArgs([])).toEqual({ apply: false, forceHost: false, allTables: false });
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--apply", "--force-host", "--all-tables"])).toEqual({ apply: true, forceHost: true, allTables: true });
    expect(() => parseArgs(["--aply"])).toThrow(/unknown/);
    expect(() => parseArgs(["apply"])).toThrow(/unknown/);
  });

  it("refuses a database that isn't the known Railway host unless --force-host", () => {
    expect(hostRefusal(`postgresql://u:p@${RAILWAY_DB_HOST}:39582/railway`, false)).toBeNull();
    expect(hostRefusal("postgresql://u:p@localhost:5432/kura", false)).toMatch(/localhost.*--force-host/);
    expect(hostRefusal("postgresql://u:p@localhost:5432/kura", true)).toBeNull();
    expect(hostRefusal(undefined, true)).toMatch(/DATABASE_URL is not set/);
    expect(hostRefusal("not a url", true)).toMatch(/not a valid URL/);
  });

  it("the refusal message never echoes credentials", () => {
    expect(hostRefusal("postgresql://user:hunter2@evil.example:5432/db", false)).not.toMatch(/hunter2|user:/);
  });
});
