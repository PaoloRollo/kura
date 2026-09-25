import { describe, expect, it } from "vitest";
import { AuthError, requireUser } from "@/lib/auth";

const req = (token?: string) => new Request("http://localhost/api/x", { headers: token ? { "privy-id-token": token } : {} });

const okUser = {
  id: "did:privy:123",
  linked_accounts: [
    { type: "email", address: "a@b.c" },
    { type: "wallet", chain_type: "ethereum", wallet_client_type: "metamask", address: "0x1111111111111111111111111111111111111111" },
    { type: "wallet", chain_type: "ethereum", wallet_client_type: "privy", address: "0x2222222222222222222222222222222222222222" },
  ],
};

describe("requireUser", () => {
  it("prefers the embedded wallet", async () => {
    const u = await requireUser(req("tok"), { getUser: async () => okUser });
    expect(u).toEqual({ did: "did:privy:123", wallet: "0x2222222222222222222222222222222222222222" });
  });
  it("falls back to any ethereum wallet", async () => {
    const u = await requireUser(req("tok"), { getUser: async () => ({ ...okUser, linked_accounts: okUser.linked_accounts.slice(0, 2) }) });
    expect(u.wallet).toBe("0x1111111111111111111111111111111111111111");
  });
  it("401s without a token, with an invalid token, and without a wallet", async () => {
    await expect(requireUser(req(), { getUser: async () => okUser })).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    await expect(requireUser(req("bad"), { getUser: async () => { throw new Error("invalid"); } })).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    await expect(requireUser(req("tok"), { getUser: async () => ({ id: "did:privy:1", linked_accounts: [] }) })).rejects.toBeInstanceOf(AuthError);
  });
});
