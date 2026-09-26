import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { privateKeyToAccount } from "viem/accounts";
import { createTestDb } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { releaseTickets } from "@/lib/db/schema";
import { setUserForTests } from "@/lib/auth";
import { deployments, resetDeploymentsForTests, setDeploymentsForTests } from "@/lib/deployments";
import { setVaultReaderForTests, type VaultCard } from "@/lib/release-tickets";
import { setWorldFetchForTests } from "@/lib/world";
import { POST as verifyRoute } from "@/app/api/worldid/verify/route";
import { GET as pendingRoute } from "@/app/api/release/pending/route";
import { POST as consumeRoute } from "@/app/api/release/consume/route";
import { DELETE as cancelRoute, GET as mineRoute } from "@/app/api/release/ticket/route";

const bob = "0x2222222222222222222222222222222222222222" as const;
const eve = "0x3333333333333333333333333333333333333333" as const;
const vendor = deployments().vendor as `0x${string}`;

let card: VaultCard = { state: 1, owner: bob };
const worldOk = (nullifier = "0x0b") =>
  vi.fn(async (_u: string | URL | Request, init?: RequestInit) =>
    new Response(JSON.stringify({ success: true, action: (JSON.parse(String(init?.body)) as { action: string }).action, nullifier, environment: "staging" }), { status: 200 }),
  ) as unknown as typeof fetch;
const proof = (signalFor: string) => ({
  protocol_version: "4.0", nonce: "n", action: "release", environment: "staging",
  responses: [{ identifier: "x", signal_hash: hashSignal(signalFor), proof: "0x", nullifier: "0x0b", issuer_schema_id: 9303, expires_at_min: 0 }],
});
const as = (wallet: `0x${string}`) => setUserForTests({ did: `did:privy:${wallet}`, wallet });
const verify = (body: unknown) => verifyRoute(new Request("http://localhost/api/worldid/verify", { method: "POST", body: JSON.stringify(body) }));
const pending = (cardId = "1") => pendingRoute(new Request(`http://localhost/api/release/pending?cardId=${cardId}`));

beforeEach(async () => {
  await createTestDb();
  process.env.SIGNER_PRIVATE_KEY = "0x" + "a1".repeat(32);
  setDeploymentsForTests({ ...deployments(), signer: privateKeyToAccount(process.env.SIGNER_PRIVATE_KEY as `0x${string}`).address });
  process.env.WORLD_ENV = "staging";
  process.env.WORLD_RP_ID = "rp_test";
  card = { state: 1, owner: bob };
  setVaultReaderForTests(async () => card);
  setWorldFetchForTests(worldOk());
});
afterEach(() => {
  resetDeploymentsForTests();
  setVaultReaderForTests(null);
});

describe("release ticket from the holder's own session", () => {
  it("refuses a caller who isn't the card's owner, before asking World", async () => {
    const world = worldOk();
    setWorldFetchForTests(world);
    as(eve);
    const res = await verify({ action: "release", cardId: "1", idkitResponse: proof(eve) });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("NOT_OWNER");
    expect(world).not.toHaveBeenCalled();
  });

  it("refuses a card that isn't Whole", async () => {
    card = { state: 3, owner: vendor };
    as(bob);
    const res = await verify({ action: "release", cardId: "1", idkitResponse: proof(bob) });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CARD_NOT_WHOLE");
  });

  it("always names the caller: a body subject is ignored and a proof for another wallet is refused", async () => {
    as(bob);
    let res = await verify({ action: "release", cardId: "1", subject: eve, idkitResponse: proof(bob) });
    expect(res.status).toBe(200);
    const [row] = await getDb().select().from(releaseTickets);
    expect(row.subject).toBe(bob);
    expect(row.cardId).toBe(1n);

    // The vendor (or anyone) cannot scan a proof into the owner's name: the signal must be the caller.
    res = await verify({ action: "release", cardId: "1", idkitResponse: proof(eve) });
    expect((await res.json()).error.code).toBe("SIGNAL_MISMATCH");
  });

  it("lets the holder see and cancel their waiting ticket", async () => {
    as(bob);
    await verify({ action: "release", cardId: "1", idkitResponse: proof(bob) });
    const mine = await (await mineRoute(new Request("http://localhost/api/release/ticket?cardId=1"))).json();
    expect(mine.ready.cardId).toBe("1");
    as(eve);
    expect((await (await mineRoute(new Request("http://localhost/api/release/ticket?cardId=1"))).json()).ready).toBeNull();
    expect((await (await cancelRoute(new Request("http://localhost/api/release/ticket?cardId=1", { method: "DELETE" }))).json()).cancelled).toBe(false);
    as(bob);
    expect((await (await cancelRoute(new Request("http://localhost/api/release/ticket?cardId=1", { method: "DELETE" }))).json()).cancelled).toBe(true);
    as(vendor);
    expect((await (await pending()).json()).pending).toBeNull();
  });
});

describe("GET /api/release/pending", () => {
  async function holderVerifies() {
    as(bob);
    expect((await verify({ action: "release", cardId: "1", idkitResponse: proof(bob) })).status).toBe(200);
    as(vendor);
  }

  it("is vendor only", async () => {
    await holderVerifies();
    as(bob);
    const res = await pending();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("hands the vendor the owner's signed PASSPORT ticket", async () => {
    await holderVerifies();
    const { pending: p } = await (await pending()).json();
    expect(p.ticket).toMatchObject({ kind: 2, subject: bob, nullifier: "11" });
    expect(p.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(Number(p.ticket.expiresAt) - Math.floor(Date.now() / 1000)).toBeGreaterThan(890);
  });

  it("returns nothing once the card changed hands, left the Whole state, or the ticket expired", async () => {
    await holderVerifies();
    card = { state: 1, owner: eve };
    expect((await (await pending()).json()).pending).toBeNull();
    card = { state: 4, owner: bob };
    expect((await (await pending()).json()).pending).toBeNull();
    card = { state: 1, owner: bob };
    await getDb().update(releaseTickets).set({ expiresAt: BigInt(Math.floor(Date.now() / 1000) - 1) });
    expect((await (await pending()).json()).pending).toBeNull();
  });

  it("stops offering a consumed ticket; consuming is vendor only", async () => {
    await holderVerifies();
    const { pending: p } = await (await pending()).json();
    as(bob);
    expect((await consumeRoute(new Request("http://localhost/api/release/consume", { method: "POST", body: JSON.stringify({ id: p.id }) }))).status).toBe(403);
    as(vendor);
    const res = await consumeRoute(new Request("http://localhost/api/release/consume", { method: "POST", body: JSON.stringify({ id: p.id }) }));
    expect((await res.json()).consumed).toBe(true);
    expect((await (await pending()).json()).pending).toBeNull();
  });

  it("offers only the newest ticket when the holder verifies twice", async () => {
    await holderVerifies();
    const first = (await (await pending()).json()).pending.id;
    await holderVerifies();
    const second = (await (await pending()).json()).pending.id;
    expect(second).not.toBe(first);
    const rows = await getDb().select().from(releaseTickets);
    expect(rows.find((r) => r.id === first)?.status).toBe("replaced");
  });
});
