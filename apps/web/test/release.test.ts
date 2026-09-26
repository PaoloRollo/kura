import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-kura-user", () => ({ useKuraUser: () => ({ identityToken: null }), apiFetch: vi.fn() }));

import { WorldIdError, fetchRpContext, verifyProof, type IssuedTicket } from "@/hooks/use-world-id-ticket";
import { checklist, describeReleaseError, mmss, releaseArgs, releaseRetryable, releaseStage, type ReleaseInputs } from "@/lib/release";
import { awaitingHandover, redeemedAt } from "@/lib/vendor";

const HOLDER = "0xDeADaD159DF0923dAF871f8B4740eD7f7F417ee9" as const;
const issued = (expiresAt: number): IssuedTicket => ({
  ticket: { kind: 2, subject: HOLDER, nullifier: "0x2a", expiresAt: String(expiresAt) },
  signature: "0xabcd",
  credential: "passport",
});
const base: ReleaseInputs = { starting: false, rpExpiresAt: null, uri: null, scanned: false, verifying: false, error: null, issued: null, released: null, now: 1_000 };

describe("release stage", () => {
  it("walks idle, starting, waiting, verifying, verified, released", () => {
    expect(releaseStage(base)).toEqual({ kind: "idle" });
    expect(releaseStage({ ...base, starting: true })).toEqual({ kind: "starting" });
    expect(releaseStage({ ...base, rpExpiresAt: 1_300, uri: "wc://x" })).toEqual({ kind: "waiting", uri: "wc://x", secondsLeft: 300, scanned: false });
    expect(releaseStage({ ...base, rpExpiresAt: 1_300, verifying: true })).toEqual({ kind: "verifying" });
    const t = issued(1_900);
    expect(releaseStage({ ...base, rpExpiresAt: 1_300, issued: t })).toEqual({ kind: "verified", issued: t, secondsLeft: 900 });
    expect(releaseStage({ ...base, issued: t, released: { hash: "0x01" } })).toEqual({ kind: "released", hash: "0x01" });
  });

  it("expires the open request and the ticket", () => {
    expect(releaseStage({ ...base, rpExpiresAt: 1_000 })).toEqual({ kind: "expired", what: "request" });
    expect(releaseStage({ ...base, issued: issued(1_000) })).toEqual({ kind: "expired", what: "ticket" });
  });

  it("shows a refusal over the open request", () => {
    expect(releaseStage({ ...base, rpExpiresAt: 1_300, error: "Verification was refused." })).toEqual({ kind: "refused", message: "Verification was refused." });
  });

  it("lights the checklist step by step", () => {
    expect(checklist({ kind: "waiting", uri: null, secondsLeft: 1, scanned: false })).toEqual(["active", "pending", "pending"]);
    expect(checklist({ kind: "verifying" })).toEqual(["done", "active", "pending"]);
    expect(checklist({ kind: "verified", issued: issued(2_000), secondsLeft: 1 })).toEqual(["done", "done", "active"]);
    expect(checklist({ kind: "released", hash: null })).toEqual(["done", "done", "done"]);
  });

  it("formats countdowns", () => {
    expect(mmss(892)).toBe("14:52");
    expect(mmss(5)).toBe("00:05");
    expect(mmss(-3)).toBe("00:00");
  });
});

describe("confirmRelease call", () => {
  it("converts the JSON ticket to the contract tuple", () => {
    expect(releaseArgs(1n, issued(1_900))).toEqual([1n, { kind: 2, subject: HOLDER, nullifier: 42n, expiresAt: 1_900n }, "0xabcd"]);
  });

  it("explains each vault refusal and needs a new check for it", () => {
    for (const name of ["OnlyVendor", "WrongState", "WrongTicketKind", "TicketSubjectMismatch", "BadSignature", "Expired", "TicketUsed"]) {
      const revert = { name, args: [], message: "reverted" };
      expect(describeReleaseError(null, revert).body).toMatch(/Nothing was released\.$/);
      expect(releaseRetryable(revert)).toBe(false);
    }
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

  it("posts the proof with the holder as subject and surfaces the server's code", async () => {
    const f = vi.fn(async () => json(200, issued(1_900)));
    expect(await verifyProof({ action: "release", subject: HOLDER, idkitResponse: { responses: [] }, identityToken: "tok" }, f)).toEqual(issued(1_900));
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({ action: "release", subject: HOLDER, idkitResponse: { responses: [] } });

    const refused = verifyProof({ action: "release", subject: HOLDER, idkitResponse: {}, identityToken: "tok" }, async () =>
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
