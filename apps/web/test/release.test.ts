import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ identityToken: null }), apiFetch: vi.fn() }));

import { WorldIdError, fetchRpContext, verifyProof, type IssuedTicket } from "@/hooks/use-world-id-ticket";
import { checklist, collectStage, matchCode, describeReleaseError, mmss, releaseArgs, releaseRetryable, releaseStage, ticketSpent, type PendingRelease } from "@/lib/release";
import { awaitingHandover, redeemedAt } from "@/lib/vendor";

const HOLDER = "0xDeADaD159DF0923dAF871f8B4740eD7f7F417ee9" as const;
const issued = (expiresAt: number): IssuedTicket => ({
  ticket: { kind: 2, subject: HOLDER, nullifier: "0x2a", expiresAt: String(expiresAt) },
  signature: "0xabcd",
  credential: "passport",
});
const pending = (expiresAt: number): PendingRelease => ({ ...issued(expiresAt), id: "t1" });

describe("release stage (vendor)", () => {
  it("waits for the owner, then shows their ticket, then the release", () => {
    expect(releaseStage({ pending: null, released: null, now: 1_000 })).toEqual({ kind: "waiting" });
    const p = pending(1_900);
    expect(releaseStage({ pending: p, released: null, now: 1_000 })).toEqual({ kind: "verified", pending: p, secondsLeft: 900 });
    expect(releaseStage({ pending: p, released: { hash: "0x01" }, now: 1_000 })).toEqual({ kind: "released", hash: "0x01" });
  });

  it("expires the ticket", () => {
    expect(releaseStage({ pending: pending(1_000), released: null, now: 1_000 })).toEqual({ kind: "expired" });
  });

  it("lights the checklist step by step", () => {
    expect(checklist({ kind: "waiting" })).toEqual(["active", "pending", "pending"]);
    expect(checklist({ kind: "verified", pending: pending(2_000), secondsLeft: 1 })).toEqual(["done", "active", "pending"]);
    expect(checklist({ kind: "released", hash: null })).toEqual(["done", "done", "done"]);
  });

  it("formats countdowns", () => {
    expect(mmss(892)).toBe("14:52");
    expect(mmss(5)).toBe("00:05");
    expect(mmss(-3)).toBe("00:00");
  });
});

describe("collect stage (owner)", () => {
  it("is idle, ready with a countdown and code, expired, or ended", () => {
    expect(collectStage(null, 1_000)).toEqual({ kind: "idle" });
    expect(collectStage({ id: "t1", expiresAt: "1899" }, 1_000)).toEqual({ kind: "ready", secondsLeft: 899, code: matchCode("t1") });
    expect(collectStage({ id: "t1", expiresAt: "1000" }, 1_000)).toEqual({ kind: "expired" });
    expect(collectStage(null, 1_000, true)).toEqual({ kind: "ended" });
  });

  it("derives a stable 4-character match code from the ticket id", () => {
    const code = matchCode("3f1c2b9e-0d4a-4c1e-9b7a-2e6f8d0c1a55");
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}$/);
    expect(matchCode("3f1c2b9e-0d4a-4c1e-9b7a-2e6f8d0c1a55")).toBe(code);
    expect(matchCode("another-ticket")).not.toBe(code);
  });
});

describe("confirmRelease call", () => {
  it("converts the JSON ticket to the contract tuple", () => {
    expect(releaseArgs(1n, issued(1_900))).toEqual([1n, { kind: 2, subject: HOLDER, nullifier: 42n, expiresAt: 1_900n }, "0xabcd"]);
  });

  it("explains each vault refusal and needs a new check for it", () => {
    for (const name of ["OnlyVendor", "WrongState", "WrongTicketKind", "TicketSubjectMismatch", "BadSignature", "Expired", "TicketUsed", "UnknownCard", "ERC721NonexistentToken", "ERC721InvalidOwner"]) {
      const revert = { name, args: [], message: "reverted" };
      expect(describeReleaseError(null, revert).body).toMatch(/Nothing was released\.$/);
      expect(releaseRetryable(revert)).toBe(false);
      expect(ticketSpent(revert)).toBe(name !== "OnlyVendor");
    }
    expect(describeReleaseError(null, { name: "UnknownCard", args: [], message: "" }).title).toBe("The card's ENS name couldn't be revoked");
    expect(ticketSpent({ name: null, args: [], message: "network" })).toBe(false);
    expect(describeReleaseError(null, { name: "TicketUsed", args: [], message: "" }).title).toBe("This ticket was already used");
    expect(releaseRetryable({ name: null, args: [], message: "network" })).toBe(true);
    expect(describeReleaseError(null, { name: null, args: [], message: "User rejected the request" }).title).toBe("Request cancelled");
  });
});

describe("World ID ticket requests", () => {
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

  it("fetches an rp context for the action", async () => {
    const f = vi.fn(async () => json(200, { rp_id: "rp_1", nonce: "n", created_at: 1, expires_at: 301, signature: "0xs" }));
    expect(await fetchRpContext("release", "tok", f)).toEqual({ rp_id: "rp_1", nonce: "n", created_at: 1, expires_at: 301, signature: "0xs" });
    expect(f).toHaveBeenCalledWith("/api/worldid/rp-context", expect.objectContaining({ body: JSON.stringify({ action: "release" }), identityToken: "tok" }));
    await expect(fetchRpContext("release", "tok", async () => json(500, {}))).rejects.toMatchObject({ code: "START_FAILED" });
  });

  it("posts the proof with the card id and surfaces the server's code", async () => {
    const f = vi.fn(async () => json(200, issued(1_900)));
    expect(await verifyProof({ action: "release", cardId: 1n, idkitResponse: { responses: [] }, identityToken: "tok" }, f)).toEqual(issued(1_900));
    // No subject is sent: the server always names the caller.
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({ action: "release", cardId: "1", idkitResponse: { responses: [] } });

    const refused = verifyProof({ action: "release", cardId: 1n, idkitResponse: {}, identityToken: "tok" }, async () =>
      json(409, { error: { code: "ALREADY_BOUND", message: "bound", details: { boundTo: "0x1" } } }),
    );
    await expect(refused).rejects.toBeInstanceOf(WorldIdError);
    await expect(refused).rejects.toMatchObject({ code: "ALREADY_BOUND", details: { boundTo: "0x1" } });
  });
});

describe("cards awaiting handover", () => {
  it("dates each Whole card's buyout by its latest sharding", () => {
    const cards = [
      { id: 1n, state: "whole" as const },
      { id: 2n, state: "whole" as const },
      { id: 3n, state: "released" as const },
    ];
    const shardings = [
      { cardId: 1n, createdAt: 10, redeemer: "0xa", updatedAt: 50 },
      { cardId: 1n, createdAt: 5, redeemer: null, updatedAt: 9 },
      { cardId: 2n, createdAt: 10, redeemer: null, updatedAt: 20 },
      { cardId: 3n, createdAt: 10, redeemer: "0xb", updatedAt: 30 },
    ];
    expect([...redeemedAt(cards, shardings)]).toEqual([[1n, 50]]);
    expect([...awaitingHandover(cards, shardings)]).toEqual([1n]);
  });
});
