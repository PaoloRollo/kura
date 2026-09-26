import "server-only";
import { and, desc, eq, gt } from "drizzle-orm";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { abi } from "@kura/shared";
import { getDb } from "@/lib/db/client";
import { releaseTickets } from "@/lib/db/schema";
import { requireDeployed } from "@/lib/deployments";
import { serverEnv } from "@/env";
import { HttpError } from "@/lib/http";
import { nowSec } from "@/lib/signer";

/** CardVault.State. */
export const CARD_STATE = { None: 0, Whole: 1, Auctioning: 2, Sharded: 3, Released: 4 } as const;

export type VaultCard = { state: number; owner: Address | null };
export type VaultReader = (cardId: bigint) => Promise<VaultCard>;

const erc721 = parseAbi(["function ownerOf(uint256) view returns (address)"]);

/** The card's vault state and NFT holder, read on-chain now (the indexer can lag a transfer). */
const liveReader: VaultReader = async (cardId) => {
  const client = createPublicClient({ chain: sepolia, transport: http(serverEnv().ALCHEMY_HTTP_URL) });
  const vault = requireDeployed().cardVault;
  const card = (await client.readContract({ address: vault, abi: abi.cardVault, functionName: "cards", args: [cardId] })) as { state: number };
  const state = Number(card.state);
  if (state === CARD_STATE.None) return { state, owner: null };
  const owner = await client.readContract({ address: vault, abi: erc721, functionName: "ownerOf", args: [cardId] });
  return { state, owner };
};

let reader: VaultReader = liveReader;
export function setVaultReaderForTests(r: VaultReader | null) {
  reader = r ?? liveReader;
}
export const readVaultCard = (cardId: bigint) => reader(cardId);

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Only the owner of a Whole card may ask for its release ticket. */
export async function requireOwnerOfWholeCard(cardId: bigint, caller: Address): Promise<void> {
  const card = await readVaultCard(cardId);
  if (card.state !== CARD_STATE.Whole) throw new HttpError("CARD_NOT_WHOLE", "only a whole card in the vault can be collected", 409);
  if (!same(card.owner, caller)) throw new HttpError("NOT_OWNER", "only the card's owner can collect it", 403);
}

export type StoredTicket = { cardId: bigint; subject: Address; nullifier: bigint; expiresAt: bigint; signature: Hex };

/** Stores a fresh pending ticket for the card; an earlier pending one is replaced. */
export async function storeReleaseTicket(t: StoredTicket): Promise<string> {
  const db = getDb();
  await db.update(releaseTickets).set({ status: "replaced", updatedAt: new Date() }).where(and(eq(releaseTickets.cardId, t.cardId), eq(releaseTickets.status, "pending")));
  const id = crypto.randomUUID();
  await db.insert(releaseTickets).values({ id, cardId: t.cardId, subject: t.subject, nullifier: t.nullifier.toString(), expiresAt: t.expiresAt, signature: t.signature, status: "pending" });
  return id;
}

type Row = typeof releaseTickets.$inferSelect;

/** The newest unexpired pending ticket for the card, optionally only one naming `subject`. */
export async function latestPending(cardId: bigint, subject?: string): Promise<Row | null> {
  const rows = await getDb()
    .select()
    .from(releaseTickets)
    .where(and(eq(releaseTickets.cardId, cardId), eq(releaseTickets.status, "pending"), gt(releaseTickets.expiresAt, nowSec())))
    .orderBy(desc(releaseTickets.createdAt));
  return rows.find((r) => !subject || same(r.subject, subject)) ?? null;
}

/** Sets a pending ticket's status (cancelled by its holder, consumed by the vendor). Returns whether one changed. */
export async function settleTicket(where: { id?: string; cardId?: bigint; subject?: string }, status: "consumed" | "cancelled"): Promise<boolean> {
  const db = getDb();
  const conds = [eq(releaseTickets.status, "pending")];
  if (where.id) conds.push(eq(releaseTickets.id, where.id));
  if (where.cardId != null) conds.push(eq(releaseTickets.cardId, where.cardId));
  const rows = await db.select().from(releaseTickets).where(and(...conds));
  const hit = rows.filter((r) => !where.subject || same(r.subject, where.subject));
  for (const r of hit) await db.update(releaseTickets).set({ status, updatedAt: new Date() }).where(eq(releaseTickets.id, r.id));
  return hit.length > 0;
}

/** The JSON the vendor station receives. */
export function pendingJson(r: Row) {
  return {
    id: r.id,
    ticket: { kind: 2, subject: r.subject as Address, nullifier: String(r.nullifier), expiresAt: r.expiresAt.toString() },
    signature: r.signature as Hex,
  };
}
