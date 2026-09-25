import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { createTestDb } from "@/lib/db/migrate";
import { setUserForTests } from "@/lib/auth";
import { POST as verifyRoute } from "@/app/api/worldid/verify/route";
import { setWorldFetchForTests } from "@/lib/world";

const alice = "0x1111111111111111111111111111111111111111" as const;
const bob = "0x2222222222222222222222222222222222222222" as const;

function idkitResponse(signalFor: string, schema = 1) {
  return {
    protocol_version: "4.0", nonce: "n", action: "bid", environment: "staging",
    responses: [{ identifier: "x", signal_hash: hashSignal(signalFor), proof: "0x", nullifier: "0x0a", issuer_schema_id: schema, expires_at_min: 0 }],
  };
}

function worldOk(nullifier = "0x0a") {
  return vi.fn(async () => new Response(JSON.stringify({ success: true, action: "bid", nullifier, environment: "staging", results: [{ identifier: "x", success: true, nullifier }] }), { status: 200 }));
}

const post = (body: unknown) => verifyRoute(new Request("http://localhost/api/worldid/verify", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

describe("POST /api/worldid/verify", () => {
  beforeEach(async () => {
    await createTestDb();
    process.env.SIGNER_PRIVATE_KEY = "0x" + "a1".repeat(32);
    process.env.WORLD_ENV = "staging";
    process.env.WORLD_RP_ID = "rp_test";
    setUserForTests({ did: "did:privy:alice", wallet: alice });
  });

  it("issues a HUMAN ticket for the caller's wallet", async () => {
    setWorldFetchForTests(worldOk());
    const res = await post({ action: "bid", idkitResponse: idkitResponse(alice) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ticket.kind).toBe(1);
    expect(json.ticket.subject).toBe(alice);
    expect(json.ticket.nullifier).toBe("10");
    expect(json.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(json.credential).toBe("proofOfHuman");
  });

  it("rejects a proof whose signal is another wallet", async () => {
    setWorldFetchForTests(worldOk());
    const res = await post({ action: "bid", idkitResponse: idkitResponse(bob) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("SIGNAL_MISMATCH");
  });

  it("refuses the same human on a second wallet", async () => {
    setWorldFetchForTests(worldOk());
    expect((await post({ action: "bid", idkitResponse: idkitResponse(alice) })).status).toBe(200);
    setUserForTests({ did: "did:privy:bob", wallet: bob });
    const res = await post({ action: "bid", idkitResponse: idkitResponse(bob) });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("ALREADY_BOUND");
  });

  it("rejects World failures and wrong environments", async () => {
    setWorldFetchForTests(vi.fn(async () => new Response(JSON.stringify({ success: false, code: "all_verifications_failed", detail: "bad" }), { status: 400 })));
    expect((await (await post({ action: "bid", idkitResponse: idkitResponse(alice) })).json()).error.code).toBe("WORLD_REJECTED");
    setWorldFetchForTests(vi.fn(async () => new Response(JSON.stringify({ success: true, action: "bid", nullifier: "0x0a", environment: "production", results: [] }), { status: 200 })));
    expect((await (await post({ action: "bid", idkitResponse: idkitResponse(alice) })).json()).error.code).toBe("WRONG_ENVIRONMENT");
  });

  it("rejects a proof made for a different action", async () => {
    const fetchSpy = worldOk();
    setWorldFetchForTests(fetchSpy);
    const res = await post({ action: "bid", idkitResponse: { ...idkitResponse(alice), action: "release" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("WORLD_REJECTED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("release tickets require the vendor, name the holder, and need a passport", async () => {
    setWorldFetchForTests(worldOk("0x0b"));
    let res = await post({ action: "release", subject: bob, idkitResponse: { ...idkitResponse(bob, 9303), action: "release" } });
    expect(res.status).toBe(403);

    setUserForTests({ did: "did:privy:vendor", wallet: (await import("@/generated/deployments.json")).default.vendor as `0x${string}` });
    res = await post({ action: "release", subject: bob, idkitResponse: { ...idkitResponse(bob, 1), action: "release" } });
    expect((await res.json()).error.code).toBe("WRONG_CREDENTIAL");

    setWorldFetchForTests(worldOk("0x0b"));
    res = await post({ action: "release", subject: bob, idkitResponse: { ...idkitResponse(bob, 9303), action: "release" } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ticket.kind).toBe(2);
    expect(json.ticket.subject).toBe(bob);
    expect(json.credential).toBe("passport");
  });
});
