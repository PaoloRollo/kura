import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
// PGlite in tests implements the same query surface; keep the type loose at the boundary.
export type AnyDb = { [K in keyof Db]: Db[K] };

let instance: AnyDb | null = null;

export function setDbForTests(db: unknown) {
  instance = db as AnyDb;
}

export function getDb(): AnyDb {
  if (instance) return instance;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 5, prepare: false });
  instance = drizzle(sql, { schema }) as unknown as AnyDb;
  return instance;
}
