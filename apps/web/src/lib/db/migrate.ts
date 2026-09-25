import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { resolve } from "node:path";
import * as schema from "./schema";
import { setDbForTests, type AnyDb } from "./client";

/** Fresh in-memory Postgres with all migrations applied. Also becomes the process-wide db for route handlers. */
export async function createTestDb(): Promise<AnyDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  setDbForTests(db);
  return db as unknown as AnyDb;
}
