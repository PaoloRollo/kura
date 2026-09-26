import { describe, expect, it } from "vitest";
import { ticketValid } from "@/hooks/use-ticket";

const W = "0x4f2c6e1a0b3d5f7a9c1e3b5d7f9a1c3e5b7da81e";
const t = (subject: string, expiresAt: number) => ({ ticket: { kind: 1, subject: subject as `0x${string}`, nullifier: "1", expiresAt: String(expiresAt) }, signature: "0x00" as const, credential: "orb" });

describe("cached World ID ticket", () => {
  it("is valid for its own wallet with more than a minute left", () => {
    expect(ticketValid(t(W, 1_000 + 61), W.toUpperCase().replace("0X", "0x"), 1_000)).toBe(true);
    expect(ticketValid(t(W, 1_000 + 60), W, 1_000)).toBe(false);
  });
  it("is never valid for another wallet or without one", () => {
    expect(ticketValid(t(W, 9_999), "0x1ee0b7a3c5e7f9a1b3c5d7e9f1a3b5c7d9e14b3c", 1_000)).toBe(false);
    expect(ticketValid(t(W, 9_999), null, 1_000)).toBe(false);
    expect(ticketValid(null, W, 1_000)).toBe(false);
  });
});
