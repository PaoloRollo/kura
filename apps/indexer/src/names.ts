import { and, eq, like } from "ponder";
import { type Context, ponder } from "ponder:registry";
import { collectors, ensNames, ensRecordLinks, ensRecords, ensResolverRecords } from "ponder:schema";
import { recordActivity } from "./lib/activity";
import { acceptCollectorRecord, addressRecordOf, ensTokenPrefix, labelHashOf, nameKindOf, sameEnsToken } from "./lib/ens";
import { linkNode, projectNode, type ResolverRecordStore, writeRecord } from "./lib/resolver-records";

type Hex = `0x${string}`;
const zeroAddress: Hex = "0x0000000000000000000000000000000000000000";
type BlockLike = { block: { number: bigint; timestamp: bigint } };

const stamp = (event: BlockLike) => ({ updatedBlock: event.block.number, updatedAt: Number(event.block.timestamp) });

// Emitted by CardNames.registerCard after the registry's LabelRegistered and the resolver's record writes (same tx).
// `owner` is deliberately not touched: for card names the registry owner is the CardNames adapter, never the holder.
ponder.on("CardNames:CardNamed", async ({ event, context }) => {
  const ts = Number(event.block.timestamp);
  const { label, node, cardId } = event.args;
  // The holder is the resolver `addr` record written just before this event (setAddress(name, 60, owner) in the multicall).
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

ponder.on("CardNames:CollectorNamed", async ({ event, context }) => {
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
  // The resolver's initialize() writes its records (Linked, then AddressUpdated for the collector's addr) earlier in
  // this transaction. Ponder delivers a factory child's logs from the factory event's own block, but at that point
  // the resolver was not yet a known collector resolver, so the guard kept them by record id only. Project them now.
  await projectNode(resolverStore(context, "CollectorResolver"), resolver, node, stamp(event));
  await recordActivity(context, event, { kind: "named", actor: collector, meta: { label, handle: true } });
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

// Registry events carry either the raw labelhash (unregister(anyId) from CardNames.revoke) or a versioned tokenId, so
// match on the high bits. External registry events: a missing row is logged rather than halting the indexer.
async function findNameByToken(context: Context, tokenId: bigint, eventName: string) {
  const candidates = await context.db.sql.select().from(ensNames).where(like(ensNames.labelHash, `${ensTokenPrefix(tokenId)}%`));
  const row = candidates.find((r) => sameEnsToken(BigInt(r.labelHash), tokenId));
  if (!row) console.warn(`${eventName}: no ens_names row for tokenId ${tokenId}, skipping`);
  return row;
}

ponder.on("EnsRegistry:LabelUnregistered", async ({ event, context }) => {
  const row = await findNameByToken(context, event.args.tokenId, "LabelUnregistered");
  if (!row) return; // CardNameRevoked still throws for Kura's own card names
  await context.db.update(ensNames, { label: row.label }).set({ revokedAt: Number(event.block.timestamp), ...stamp(event) });
});

// register() emits ResolverUpdated right after LabelRegistered; setResolver() emits it on a later change.
ponder.on("EnsRegistry:ResolverUpdated", async ({ event, context }) => {
  const row = await findNameByToken(context, event.args.tokenId, "ResolverUpdated");
  if (!row) return;
  const resolver = event.args.resolver === zeroAddress ? null : event.args.resolver;
  await context.db.update(ensNames, { label: row.label }).set({ resolver, ...stamp(event) });
});

type ResolverSource = "EnsResolver" | "CollectorResolver";

// Collectors hold root roles on their own resolver and could write any node there (for example a card's addr), so
// only records for the collector's own node on the collector's own resolver are projected. The shared EnsResolver is
// Kura-controlled (only the vendor and appraiser hold scoped roles) and is not filtered.
async function isOwnCollectorRecord(context: Context, resolver: Hex, node: Hex): Promise<boolean> {
  const [collector] = await context.db.sql.select().from(collectors).where(eq(collectors.resolver, resolver.toLowerCase() as Hex)).limit(1);
  if (acceptCollectorRecord(collector, resolver, node)) return true;
  console.debug(`CollectorResolver ${resolver}: not projecting records for node ${node} (not the collector's own node)`);
  return false;
}

// ens_record_links / ens_resolver_records / ens_records behind the record-id logic in src/lib/resolver-records.ts.
function resolverStore(context: Context, source: ResolverSource): ResolverRecordStore {
  const lc = (a: Hex) => a.toLowerCase() as Hex;
  return {
    linkOf: async (resolver, node) => (await context.db.find(ensRecordLinks, { resolver: lc(resolver), node }))?.recordId,
    putLink: async (resolver, node, recordId, name, s) => {
      await context.db.insert(ensRecordLinks).values({ resolver: lc(resolver), node, recordId, name, ...s })
        .onConflictDoUpdate({ recordId, name, ...s });
    },
    linkedNodes: async (resolver, recordId) => {
      const rows = await context.db.sql.select({ node: ensRecordLinks.node }).from(ensRecordLinks)
        .where(and(eq(ensRecordLinks.resolver, lc(resolver)), eq(ensRecordLinks.recordId, recordId)));
      return rows.map((r) => r.node);
    },
    recordValues: async (resolver, recordId) =>
      context.db.sql.select({
        key: ensResolverRecords.key,
        value: ensResolverRecords.value,
        setBy: ensResolverRecords.setBy,
        updatedBlock: ensResolverRecords.updatedBlock,
        updatedAt: ensResolverRecords.updatedAt,
      }).from(ensResolverRecords)
        .where(and(eq(ensResolverRecords.resolver, lc(resolver)), eq(ensResolverRecords.recordId, recordId))),
    putRecordValue: async (resolver, recordId, key, v) => {
      await context.db.insert(ensResolverRecords).values({ resolver: lc(resolver), recordId, key, ...v }).onConflictDoUpdate(v);
    },
    putNodeRecord: async (node, key, resolver, v) => {
      const fields = { ...v, resolver: lc(resolver) };
      await context.db.insert(ensRecords).values({ node, key, ...fields }).onConflictDoUpdate(fields);
    },
    clearNodeRecords: async (node, resolver) => {
      const rows = await context.db.sql.select({ key: ensRecords.key }).from(ensRecords)
        .where(and(eq(ensRecords.node, node), eq(ensRecords.resolver, lc(resolver))));
      for (const { key } of rows) await context.db.delete(ensRecords, { node, key });
    },
    acceptsNode: async (resolver, node) => source === "EnsResolver" || isOwnCollectorRecord(context, resolver, node),
  };
}

type ResolverEvent = BlockLike & { log: { address: Hex }; transaction: { from: Hex } };

// Resolver logs are indexed whoever calls the resolver, so records the vendor or appraiser set directly (outside any
// Kura contract call) land here too. setBy is the transaction sender: the vendor or appraiser for direct edits, the
// caller of the Kura transaction for records written through CardVault/CardNames. Under relayed or sponsored
// transactions (ERC-4337 bundlers, Privy gas sponsorship) it may be the relayer rather than the signer.
const valueOf = (event: ResolverEvent, value: string) => ({ value, setBy: event.transaction.from, ...stamp(event) });

for (const source of ["EnsResolver", "CollectorResolver"] as const) {
  // Linked is stored unfiltered: a collector resolver's links arrive before CollectorNamed makes the resolver known,
  // and a link alone changes no ens_records row the guard would not also check.
  ponder.on(`${source}:Linked`, async ({ event, context }) => {
    await linkNode(resolverStore(context, source), event.log.address, event.args.recordId, event.args.node, event.args.name, stamp(event));
  });
  ponder.on(`${source}:TextUpdated`, async ({ event, context }) => {
    const { recordId, key, value } = event.args;
    await writeRecord(resolverStore(context, source), event.log.address, recordId, key, valueOf(event, value));
  });
  ponder.on(`${source}:AddressUpdated`, async ({ event, context }) => {
    const { key, value } = addressRecordOf(event.args.coinType, event.args.addressBytes);
    await writeRecord(resolverStore(context, source), event.log.address, event.args.recordId, key, valueOf(event, value));
  });
}
