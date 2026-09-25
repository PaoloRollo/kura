import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/env";

describe("env", () => {
  it("rejects a missing private key and accepts a complete env", () => {
    expect(() => parseServerEnv({ PRIVY_APP_ID: "a", PRIVY_APP_SECRET: "b" })).toThrow();
    const env = parseServerEnv({
      PRIVY_APP_ID: "a", PRIVY_APP_SECRET: "b", SIGNER_PRIVATE_KEY: "0x" + "11".repeat(32), WORLD_APP_ID: "app_x",
      WORLD_RP_ID: "rp", WORLD_RP_SIGNING_KEY: "ab".repeat(32), WORLD_ENV: "staging",
      DATABASE_URL: "postgres://x", ALCHEMY_HTTP_URL: "https://x", ALCHEMY_WS_URL: "wss://x", PONDER_URL: "http://localhost:42069",
    });
    expect(env.WORLD_ENV).toBe("staging");
  });
});
