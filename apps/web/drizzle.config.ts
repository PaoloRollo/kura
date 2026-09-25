import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  schemaFilter: ["app"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/kura" },
});
