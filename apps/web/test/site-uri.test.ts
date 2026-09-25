import { describe, expect, it, vi } from "vitest";
import { siteUriReader } from "@/lib/site-uri";

describe("siteUriReader", () => {
  it("reads the vault's siteURI once and caches it", async () => {
    const read = vi.fn(async () => "https://kuravault.xyz/app/cards/");
    let now = 0;
    const get = siteUriReader(read, { ttlMs: 1000, now: () => now });
    expect(await get()).toBe("https://kuravault.xyz/app/cards/");
    expect(await get()).toBe("https://kuravault.xyz/app/cards/");
    expect(read).toHaveBeenCalledTimes(1);
    now = 2000;
    await get();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("falls back to the kuravault.xyz card pages when the read fails or is empty", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await siteUriReader(async () => { throw new Error("rpc"); })()).toBe("https://kuravault.xyz/app/cards/");
    expect(await siteUriReader(async () => "")()).toBe("https://kuravault.xyz/app/cards/");
    err.mockRestore();
  });
});
