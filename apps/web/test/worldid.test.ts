import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { createTestDb } from "@/lib/db/migrate";
import { setUserForTests } from "@/lib/auth";
import { POST as verifyRoute } from "@/app/api/worldid/verify/route";
import { POST as rpContextRoute } from "@/app/api/worldid/rp-context/route";
import { getDb } from "@/lib/db/client";
import { worldidVerifications } from "@/lib/db/schema";
import { setWorldFetchForTests } from "@/lib/world";

const alice = "0x1111111111111111111111111111111111111111" as const;
const bob = "0x2222222222222222222222222222222222222222" as const;

function idkitResponse(signalFor: string, schema = 1) {
  return {
    protocol_version: "4.0", nonce: "n", action: "bid", environment: "staging",
    responses: [{ identifier: "x", signal_hash: hashSignal(signalFor), proof: "0x", nullifier: "0x0a", issuer_schema_id: schema, expires_at_min: 0 }],
  };
}

function legacyResponse(signalFor: string, identifier: string, action = "bid") {
  return {
    protocol_version: "3.0", nonce: "n", action, environment: "staging",
    responses: [{ identifier, signal_hash: hashSignal(signalFor), proof: "0x", merkle_root: "0x01", nullifier: "0x0c" }],
  };
}

/** World's verify endpoint, echoing the action of the forwarded payload (or a forced one). */
function worldOk(nullifier = "0x0a", forceAction?: string) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const action = forceAction ?? (JSON.parse(String(init?.body)) as { action: string }).action;
    return new Response(JSON.stringify({ success: true, action, nullifier, environment: "staging", results: [{ identifier: "x", success: true, nullifier }] }), { status: 200 });
  }) as unknown as typeof fetch;
}

const vendorWallet = async () => (await import("@/generated/deployments.json")).default.vendor as `0x${string}`;

const post = (body: unknown) => verifyRoute(new Request("http://localhost/api/worldid/verify", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

describe("POST /api/worldid/verify", () => {
  beforeEach(async () => {
    await createTestDb();
    process.env.SIGNER_PRIVATE_KEY = "0x" + "a1".repeat(32);
    process.env.WORLD_ENV = "staging";
    process.env.WORLD_RP_ID = "rp_test";
    delete process.env.WORLD_BID_ALLOW_LEGACY;
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

    setUserForTests({ did: "did:privy:vendor", wallet: await vendorWallet() });
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
  it("refuses legacy v3 proofs for bid unless WORLD_BID_ALLOW_LEGACY is on", async () => {
    const fetchSpy = worldOk("0x0c");
    setWorldFetchForTests(fetchSpy);
    delete process.env.WORLD_BID_ALLOW_LEGACY;
    let res = await post({ action: "bid", idkitResponse: legacyResponse(alice, "orb") });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("WRONG_CREDENTIAL");
    expect(fetchSpy).not.toHaveBeenCalled();

    process.env.WORLD_BID_ALLOW_LEGACY = "true";
    try {
      res = await post({ action: "bid", idkitResponse: legacyResponse(alice, "orb") });
      expect(res.status).toBe(200);
      expect((await res.json()).credential).toBe("proofOfHuman");
    } finally {
      delete process.env.WORLD_BID_ALLOW_LEGACY;
    }
  });

  it("maps legacy v3 credentials through an allowlist", async () => {
    setWorldFetchForTests(worldOk("0x0c"));
    process.env.WORLD_BID_ALLOW_LEGACY = "true";
    let res: Response;

    res = await post({ action: "bid", idkitResponse: legacyResponse(alice, "device") });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("WRONG_CREDENTIAL");

    res = await post({ action: "bid", idkitResponse: { ...legacyResponse(alice, "orb"), responses: [{ ...legacyResponse(alice, "orb").responses[0], identifier: undefined }] } });
    expect((await res.json()).error.code).toBe("WRONG_CREDENTIAL");

    delete process.env.WORLD_BID_ALLOW_LEGACY;
    // Release keeps accepting legacy proofs without the flag.
    setUserForTests({ did: "did:privy:vendor", wallet: await vendorWallet() });
    res = await post({ action: "release", subject: bob, idkitResponse: legacyResponse(bob, "document", "release") });
    expect(res.status).toBe(200);
    expect((await res.json()).credential).toBe("passport");
  });

  it("rejects a v4 response without an issuer schema id", async () => {
    setWorldFetchForTests(worldOk());
    const r = idkitResponse(alice);
    const item: Record<string, unknown> = { ...r.responses[0] };
    delete item.issuer_schema_id;
    const res = await post({ action: "bid", idkitResponse: { ...r, responses: [item] } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("WRONG_CREDENTIAL");
  });

  it("binds a release nullifier to one holder", async () => {
    setUserForTests({ did: "did:privy:vendor", wallet: await vendorWallet() });
    setWorldFetchForTests(worldOk("0x0b"));
    const charlie = "0x3333333333333333333333333333333333333333" as const;
    expect((await post({ action: "release", subject: bob, idkitResponse: { ...idkitResponse(bob, 9303), action: "release" } })).status).toBe(200);
    expect((await post({ action: "release", subject: bob, idkitResponse: { ...idkitResponse(bob, 9303), action: "release" } })).status).toBe(200);
    const res = await post({ action: "release", subject: charlie, idkitResponse: { ...idkitResponse(charlie, 9303), action: "release" } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("ALREADY_BOUND");
  });

  it("returns ALREADY_BOUND when a binding row for another wallet already exists", async () => {
    await getDb().insert(worldidVerifications).values({ id: "pre", nullifier: "10", action: "bid", subject: bob, environment: "staging", credential: "proofOfHuman" });
    setWorldFetchForTests(worldOk());
    const res = await post({ action: "bid", idkitResponse: idkitResponse(alice) });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("ALREADY_BOUND");
  });

  it("requires exactly one response item", async () => {
    setWorldFetchForTests(worldOk());
    const r = idkitResponse(alice);
    let res = await post({ action: "bid", idkitResponse: { ...r, responses: [r.responses[0], r.responses[0]] } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("WORLD_REJECTED");
    res = await post({ action: "bid", idkitResponse: { ...r, responses: [] } });
    expect((await res.json()).error.code).toBe("WORLD_REJECTED");
  });

  it("rejects when World reports a different action", async () => {
    setWorldFetchForTests(worldOk("0x0a", "release"));
    const res = await post({ action: "bid", idkitResponse: idkitResponse(alice) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("WORLD_REJECTED");
  });

  it("treats malformed World responses as rejections", async () => {
    setWorldFetchForTests(vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch);
    let res = await post({ action: "bid", idkitResponse: idkitResponse(alice) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("WORLD_REJECTED");

    setWorldFetchForTests(worldOk("not-a-number"));
    res = await post({ action: "bid", idkitResponse: idkitResponse(alice) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("WORLD_REJECTED");
  });

  it("requires a subject for vendor release requests", async () => {
    setUserForTests({ did: "did:privy:vendor", wallet: await vendorWallet() });
    setWorldFetchForTests(worldOk("0x0b"));
    const res = await post({ action: "release", idkitResponse: { ...idkitResponse(bob, 9303), action: "release" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");
  });

  it("fails with CONFIG when WORLD_RP_ID is missing", async () => {
    delete process.env.WORLD_RP_ID;
    setWorldFetchForTests(worldOk());
    const res = await post({ action: "bid", idkitResponse: idkitResponse(alice) });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("CONFIG");
  });
});

describe("POST /api/worldid/rp-context", () => {
  const post = (body: unknown) => rpContextRoute(new Request("http://localhost/api/worldid/rp-context", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

  beforeEach(() => {
    process.env.WORLD_RP_ID = "rp_test";
    process.env.WORLD_RP_SIGNING_KEY = "a2".repeat(32);
    setUserForTests({ did: "did:privy:alice", wallet: alice });
  });

  it("signs a request context for the action", async () => {
    const res = await post({ action: "bid" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.rp_id).toBe("rp_test");
    expect(typeof json.nonce).toBe("string");
    expect(typeof json.signature).toBe("string");
    expect(json.expires_at).toBeGreaterThan(json.created_at);
  });

  it("fails with CONFIG when the signing key or rp id is missing", async () => {
    delete process.env.WORLD_RP_SIGNING_KEY;
    let res = await post({ action: "bid" });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("CONFIG");
    process.env.WORLD_RP_SIGNING_KEY = "a2".repeat(32);
    delete process.env.WORLD_RP_ID;
    res = await post({ action: "bid" });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("CONFIG");
  });
});
