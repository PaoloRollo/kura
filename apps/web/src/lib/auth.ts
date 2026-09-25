import "server-only";
import { PrivyClient } from "@privy-io/node";
import type { Address } from "viem";
import { serverEnv } from "@/env";

export type KuraUser = { did: string; wallet: Address };

export class AuthError extends Error {
  readonly status = 401;
  constructor(public readonly code: "UNAUTHENTICATED" | "NO_WALLET", message: string) {
    super(message);
  }
}

type LinkedAccount = { type: string; address?: string; chain_type?: string; wallet_client_type?: string };
type PrivyUserLike = { id: string; linked_accounts: LinkedAccount[] };
type Deps = { getUser: (idToken: string) => Promise<PrivyUserLike> };

let client: PrivyClient | null = null;
function privy(): PrivyClient {
  if (!client) {
    const env = serverEnv();
    client = new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
  }
  return client;
}

let testUser: KuraUser | null = null;
/** Route tests set a fake user; only honoured when NODE_ENV === "test". */
export function setUserForTests(user: KuraUser | null) {
  testUser = user;
}

const defaultDeps: Deps = {
  // Verifies the identity token's signature and returns the user with linked accounts.
  getUser: async (idToken) => (await privy().users().get({ id_token: idToken })) as unknown as PrivyUserLike,
};

function readIdToken(req: Request): string | null {
  const header = req.headers.get("privy-id-token");
  if (header) return header;
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)privy-id-token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function requireUser(req: Request, deps: Deps = defaultDeps): Promise<KuraUser> {
  if (process.env.NODE_ENV === "test" && testUser) return testUser;
  const token = readIdToken(req);
  if (!token) throw new AuthError("UNAUTHENTICATED", "missing identity token");
  let user: PrivyUserLike;
  try {
    user = await deps.getUser(token);
  } catch {
    throw new AuthError("UNAUTHENTICATED", "invalid identity token");
  }
  const wallets = user.linked_accounts.filter((a) => a.type === "wallet" && a.chain_type === "ethereum" && a.address);
  const embedded = wallets.find((a) => a.wallet_client_type === "privy") ?? wallets[0];
  if (!embedded?.address) throw new AuthError("NO_WALLET", "user has no ethereum wallet");
  return { did: user.id, wallet: embedded.address as Address };
}
