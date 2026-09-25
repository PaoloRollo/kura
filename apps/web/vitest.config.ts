import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  resolve: {
    // `server-only` throws when imported outside a React Server Component,
    // which vitest's node environment is not; alias it to an empty stub for tests.
    alias: { "server-only": path.resolve(__dirname, "test/server-only-stub.ts") },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
  },
});
