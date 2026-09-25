import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Modules that hold secrets or touch the database must never reach a client bundle.
const SERVER_MODULES = ["lib/auth.ts", "lib/db/client.ts", "lib/deployments.ts", "lib/ponder-server.ts", "lib/scan.ts", "lib/scryfall.ts", "lib/signer.ts", "lib/vault-site-uri.ts", "lib/world.ts"];

describe("server-only guards", () => {
  it.each(SERVER_MODULES)("%s imports server-only", (file) => {
    const src = readFileSync(path.resolve(__dirname, "../src", file), "utf8");
    expect(src).toMatch(/^import "server-only";$/m);
  });
});
