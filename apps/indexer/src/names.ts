import { eq, like } from "ponder";
import { type Context, ponder } from "ponder:registry";
import { collectors, ensNames, ensRecords } from "ponder:schema";
import { recordActivity } from "./lib/activity";
import { acceptCollectorRecord, ensTokenPrefix, labelHashOf, nameKindOf, sameEnsToken } from "./lib/ens";

type Hex = `0x${string}`;
type BlockLike = { block: { number: bigint; timestamp: bigint } };

const stamp = (event: BlockLike) => ({ updatedBlock: event.block.number, updatedAt: Number(event.block.timestamp) });

// Emitted by CardNames.registerCard after the registry's LabelRegistered and the resolver's record writes (same tx).
// `owner` is deliberately not touched: for card names the registry owner is the CardNames adapter, never the holder.
ponder.on("CardNames:CardNamed", async ({ event, context }) => {
  const ts = Number(event.block.timestamp);
  const { label, node, cardId } = event.args;
  // The holder is the resolver `addr` record written just before this event (setAddr(node, owner) in the multicall).
  const addr = await context.db.find(ensRecords, { node, key: "addr" });
  if (!addr) throw new Error(`CardNamed ${label}: no addr record for node ${node}`);
  await context.db.insert(ensNames).values({
    label,
    labelHash: labelHashOf(label),
    kind: "card",
    node,
    tokenId: null,
    owner: null,
    resolver: addr.resolver,
    cardId,
    expiry: null,
    registeredAt: ts,
    revokedAt: null,
    ...stamp(event),
  }).onConflictDoUpdate({ kind: "card", node, resolver: addr.resolver, cardId, revokedAt: null, ...stamp(event) });
  await recordActivity(context, event, { kind: "named", cardId, actor: addr.value as Hex, meta: { label, node } });
});

ponder.on("CardNames:CardNameRevoked", async ({ event, context }) => {
  await context.db.update(ensNames, { label: event.args.label }).set({ revokedAt: Number(event.block.timestamp), ...stamp(event) });
});

type CollectorNamedEvent = BlockLike & { args: { collector: Hex; label: string; resolver: Hex; node: Hex } };

async function indexCollectorNamed(context: Context, event: CollectorNamedEvent) {
  const ts = Number(event.block.timestamp);
  const { collector, label, resolver, node } = event.args;
  await context.db.insert(ensNames).values({
    label,
    labelHash: labelHashOf(label),
    kind: "collector",
    node,
    tokenId: null,
    owner: collector,
    resolver,
    cardId: null,
    expiry: null,
    registeredAt: ts,
    revokedAt: null,
    ...stamp(event),
  }).onConflictDoUpdate({ kind: "collector", owner: collector, resolver, node, ...stamp(event) });
  await context.db.insert(collectors).values({ address: collector, label, resolver, node, blockNumber: event.block.number, registeredAt: ts })
    .onConflictDoUpdate({ label, resolver, node, blockNumber: event.block.number });
  // The resolver's initialize() emits AddrChanged before this event, when the resolver is not yet a known collector
  // resolver, so the CollectorResolver guard drops it. Write the collector's own addr record here instead.
  const addrRecord = { value: collector.toLowerCase(), setBy: collector, resolver, ...stamp(event) };
  await context.db.insert(ensRecords).values({ node, key: "addr", ...addrRecord }).onConflictDoUpdate(addrRecord);
}

ponder.on("CardNames:CollectorNamed", async ({ event, context }) => {
  await indexCollectorNamed(context, event);
  await recordActivity(context, event, { kind: "named", actor: event.args.collector, meta: { label: event.args.label, handle: true } });
});

// A handle claimed through an earlier deployment's adapter (src/lib/legacy.ts): imported state, so no activity row.
ponder.on("LegacyCardNames:CollectorNamed", async ({ event, context }) => {
  await indexCollectorNamed(context, event);
});

// Registry events add token ids, owners and expiries; the label is in the event. The row's labelHash comes from the
// event too, because the tokenId differs from it in the low 32 bits (ENSv2 version).
ponder.on("EnsRegistry:LabelRegistered", async ({ event, context }) => {
  const ts = Number(event.block.timestamp);
  const { label, labelHash, tokenId, owner, expiry } = event.args;
  await context.db.insert(ensNames).values({
    label,
    labelHash,
    kind: nameKindOf(label),
    node: null,
    tokenId,
    owner,
    resolver: null,
    cardId: null,
    expiry,
    registeredAt: ts,
    revokedAt: null,
    ...stamp(event),
  }).onConflictDoUpdate({ labelHash, tokenId, owner, expiry, revokedAt: null, ...stamp(event) });
});

// unregister(anyId) accepts the raw labelhash (CardNames.revoke) or a versioned tokenId, so match on the high bits.
ponder.on("EnsRegistry:LabelUnregistered", async ({ event, context }) => {
  const { tokenId } = event.args;
  const candidates = await context.db.sql.select().from(ensNames).where(like(ensNames.labelHash, `${ensTokenPrefix(tokenId)}%`));
  const row = candidates.find((r) => sameEnsToken(BigInt(r.labelHash), tokenId));
  // External registry event: a missing revokedAt is better than halting the indexer. CardNameRevoked still throws.
  if (!row) {
    console.warn(`LabelUnregistered: no ens_names row for tokenId ${tokenId}, skipping`);
    return;
  }
  await context.db.update(ensNames, { label: row.label }).set({ revokedAt: Number(event.block.timestamp), ...stamp(event) });
});

type RecordEvent = BlockLike & { log: { address: Hex }; transaction: { from: Hex } };

// Resolver logs are indexed whoever calls the resolver, so records the vendor or appraiser set directly (outside any
// Kura contract call) land here too. setBy is the transaction sender: the vendor or appraiser for direct edits, the
// caller of the Kura transaction for records written through CardVault/CardNames. Under relayed or sponsored
// transactions (ERC-4337 bundlers, Privy gas sponsorship) it may be the relayer rather than the signer.
async function upsertRecord(context: Context, event: RecordEvent, node: Hex, key: string, value: string) {
  const fields = { value, setBy: event.transaction.from, resolver: event.log.address, ...stamp(event) };
  await context.db.insert(ensRecords).values({ node, key, ...fields }).onConflictDoUpdate(fields);
}

ponder.on("EnsResolver:TextChanged", async ({ event, context }) => {
  await upsertRecord(context, event, event.args.node, event.args.key, event.args.value);
});
// addr values are stored lowercase so they compare directly with hex columns such as cards.beneficialOwner.
ponder.on("EnsResolver:AddrChanged", async ({ event, context }) => {
  await upsertRecord(context, event, event.args.node, "addr", event.args.a.toLowerCase());
});
// Collectors hold root roles on their own resolver and could write any node there (for example a card's addr), so
// only records for the collector's own node on the collector's own resolver are kept. The shared EnsResolver is
// Kura-controlled (only the vendor and appraiser hold scoped roles) and is not filtered.
async function isOwnCollectorRecord(context: Context, resolver: Hex, node: Hex): Promise<boolean> {
  const [collector] = await context.db.sql.select().from(collectors).where(eq(collectors.resolver, resolver.toLowerCase() as Hex)).limit(1);
  if (acceptCollectorRecord(collector, resolver, node)) return true;
  console.debug(`CollectorResolver ${resolver}: ignoring record for node ${node} (not the collector's own node)`);
  return false;
}

for (const source of ["CollectorResolver", "LegacyCollectorResolver"] as const) {
  ponder.on(`${source}:TextChanged`, async ({ event, context }) => {
    if (!(await isOwnCollectorRecord(context, event.log.address, event.args.node))) return;
    await upsertRecord(context, event, event.args.node, event.args.key, event.args.value);
  });
  ponder.on(`${source}:AddrChanged`, async ({ event, context }) => {
    if (!(await isOwnCollectorRecord(context, event.log.address, event.args.node))) return;
    await upsertRecord(context, event, event.args.node, "addr", event.args.a.toLowerCase());
  });
}
