// Resets the shared Postgres after a full contract redeploy: drops the Ponder schemas (a new deploy block needs a fresh
// index) and empties the web app's chain-bound tables. The Drizzle migrations table and the table structure stay.
//
//   pnpm db:reset                    connect read-only and print the plan; changes nothing
//   pnpm db:reset --apply            run the plan in one transaction
//   --all-tables                     also empty the chain-independent tables (Scryfall cache, price history, profiles)
//   --force-host                     allow a DATABASE_URL other than the known Railway host
//
// Reads DATABASE_URL from the root .env (a variable already set in the shell wins).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

export const RAILWAY_DB_HOST = "iriguchi.proxy.rlwy.net";

/** App tables that hold no chain state. Kept unless --all-tables: the price history can't be rebuilt. */
export const KEPT_APP_TABLES = [
  { name: "scryfall_cache", reason: "Scryfall card cache, not chain data" },
  { name: "market_prices", reason: "daily price history from the cron; cannot be re-fetched" },
  { name: "collector_profiles", reason: "Privy account to wallet labels, not chain data" },
] as const;

type Named = { name: string; reason: string };
export type TableRef = { schema: string; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTECTED: Record<string, string> = {
  public: "Postgres default schema",
  information_schema: "system",
  app: "web app tables (emptied, not dropped)",
  drizzle: "Drizzle migrations table",
  ponder_sync: "Ponder's RPC cache, keyed by chain and address; safe to keep",
};

/** Which schemas to drop. Anything not recognised as a Ponder schema is kept. */
export function classifySchemas(names: string[]): { drop: Named[]; keep: Named[] } {
  const drop: Named[] = [];
  const keep: Named[] = [];
  for (const name of names) {
    if (name in PROTECTED) keep.push({ name, reason: PROTECTED[name]! });
    else if (name.startsWith("pg_")) keep.push({ name, reason: "system" });
    else if (name === "kura") drop.push({ name, reason: "Ponder views schema (--views-schema kura)" });
    else if (name === "kura_dev") drop.push({ name, reason: "Ponder local dev schema (DATABASE_SCHEMA)" });
    else if (/^kura_[a-z0-9_]+$/.test(name)) drop.push({ name, reason: "Ponder deployment schema (kura_<sha>)" });
    else if (UUID.test(name)) drop.push({ name, reason: "Ponder deployment schema (Railway deployment id)" });
    else keep.push({ name, reason: "unrecognised, left alone" });
  }
  return { drop, keep };
}

/** Every table in a Drizzle schema module, as schema-qualified names. */
export function appTablesFromSchema(mod: Record<string, unknown>): TableRef[] {
  const out: TableRef[] = [];
  for (const v of Object.values(mod)) {
    if (!(v instanceof PgTable)) continue;
    const c = getTableConfig(v);
    out.push({ schema: c.schema ?? "public", name: c.name });
  }
  return out;
}

export type ResetPlan = {
  dropSchemas: Named[];
  keepSchemas: Named[];
  truncate: TableRef[];
  keepTables: (TableRef & { reason: string })[];
  /** In the Drizzle schema but not in the database (migrations not run yet); skipped. */
  missingTables: TableRef[];
};

export function planReset(p: { schemas: string[]; appTables: TableRef[]; existingTables: Set<string>; allTables: boolean }): ResetPlan {
  const { drop, keep } = classifySchemas(p.schemas);
  const truncate: TableRef[] = [];
  const keepTables: ResetPlan["keepTables"] = [];
  const missingTables: TableRef[] = [];
  for (const t of p.appTables) {
    if (!p.existingTables.has(`${t.schema}.${t.name}`)) { missingTables.push(t); continue; }
    const kept = KEPT_APP_TABLES.find((k) => k.name === t.name);
    if (kept && !p.allTables) keepTables.push({ ...t, reason: kept.reason });
    else truncate.push(t);
  }
  return { dropSchemas: drop, keepSchemas: keep, truncate, keepTables, missingTables };
}

const q = (id: string) => `"${id.replaceAll('"', '""')}"`;

export function resetStatements(p: ResetPlan): string[] {
  const out = p.dropSchemas.map((s) => `DROP SCHEMA ${q(s.name)} CASCADE`);
  if (p.truncate.length) out.push(`TRUNCATE ${p.truncate.map((t) => `${q(t.schema)}.${q(t.name)}`).join(", ")} RESTART IDENTITY CASCADE`);
  return out;
}

export function formatPlan(p: ResetPlan, host: string): string {
  const lines = [`Database ${host}`, "", "Schemas"];
  for (const s of p.dropSchemas) lines.push(`  DROP SCHEMA  ${s.name}  (${s.reason})`);
  const system = p.keepSchemas.filter((s) => s.name.startsWith("pg_"));
  for (const s of p.keepSchemas) if (!s.name.startsWith("pg_")) lines.push(`  keep         ${s.name}  (${s.reason})`);
  if (system.length) lines.push(`  keep         pg_*  (${system.length} system schemas)`);
  lines.push("", "App tables");
  for (const t of p.truncate) lines.push(`  TRUNCATE     ${t.schema}.${t.name}`);
  for (const t of p.keepTables) lines.push(`  keep         ${t.schema}.${t.name}  (${t.reason}; --all-tables to empty it)`);
  for (const t of p.missingTables) lines.push(`  missing      ${t.schema}.${t.name}  (not in the database; skipped)`);
  lines.push("  keep         drizzle.__drizzle_migrations and every table's structure");
  return lines.join("\n");
}

export type ResetArgs = { apply: boolean; forceHost: boolean; allTables: boolean };

export function parseArgs(argv: string[]): ResetArgs {
  const a: ResetArgs = { apply: false, forceHost: false, allTables: false };
  for (const x of argv) {
    if (x === "--apply") a.apply = true;
    else if (x === "--force-host") a.forceHost = true;
    else if (x === "--all-tables") a.allTables = true;
    else throw new Error(`unknown argument ${x} (use --apply, --all-tables, --force-host)`);
  }
  return a;
}

/** Why this DATABASE_URL must not be reset, or null. Never echoes credentials. */
export function hostRefusal(url: string | undefined, forceHost: boolean): string | null {
  if (!url) return "DATABASE_URL is not set (root .env)";
  let host: string;
  try { host = new URL(url).hostname; } catch { return "DATABASE_URL is not a valid URL"; }
  if (host !== RAILWAY_DB_HOST && !forceHost) return `DATABASE_URL points at ${host}, not the known Railway host ${RAILWAY_DB_HOST}; pass --force-host if that is intended`;
  return null;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  const refusal = hostRefusal(url, args.forceHost);
  if (refusal) throw new Error(refusal);
  const host = new URL(url!).hostname;

  const { default: postgres } = await import("postgres");
  const schemaModule = await import("../../apps/web/src/lib/db/schema");
  // Without --apply every statement runs in a read-only transaction.
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {}, connection: args.apply ? {} : { default_transaction_read_only: true } });
  try {
    const schemas = (await sql<{ schema_name: string }[]>`select schema_name from information_schema.schemata order by schema_name`).map((r) => r.schema_name);
    const tables = await sql<{ table_schema: string; table_name: string }[]>`
      select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE'`;
    const existingTables = new Set(tables.map((t) => `${t.table_schema}.${t.table_name}`));
    const plan = planReset({ schemas, appTables: appTablesFromSchema(schemaModule), existingTables, allTables: args.allTables });
    console.log(formatPlan(plan, host));
    const statements = resetStatements(plan);
    if (!args.apply) {
      console.log(`\nNot applied (${statements.length} statements). Rerun with --apply to run them.`);
      return;
    }
    if (!statements.length) { console.log("\nNothing to do."); return; }
    await sql.begin(async (tx) => {
      for (const s of statements) {
        console.log(`  ${s}`);
        await tx.unsafe(s);
      }
    });
    console.log("\nApplied. Redeploy the indexer so Ponder rebuilds its schema from the new deploy block.");
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`\n✗ ${process.env.DATABASE_URL ? msg.replaceAll(process.env.DATABASE_URL, "<DATABASE_URL>") : msg}`);
      process.exit(1);
    },
  );
}
