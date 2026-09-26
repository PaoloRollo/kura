import type { Hex } from "viem";
import { isUnlink } from "./ens";

/**
 * ENSv2 PermissionedResolver keys records by record id, not by node:
 * - every setter runs `_ensureRecord(name)`, which on a node's first write allocates a record id and emits
 *   `Linked(recordId, node, name)` BEFORE the setter's own event (same call), so in-order indexing sees the link first;
 * - `linkToNode` / `linkToRecord` re-point a node at an existing record, so one record id can back several nodes
 *   (aliases), and a node can move from one record to another; `linkToRecord(name, 0)` unlinks it;
 * - record events (TextUpdated, AddressUpdated) carry only the record id.
 * Values are kept per record id (ens_resolver_records) and projected onto ens_records(node, key) for every node linked
 * to the id, which is what the web reads.
 */

export type Stamp = { updatedBlock: bigint; updatedAt: number };
export type RecordValue = Stamp & { value: string; setBy: Hex };

export interface ResolverRecordStore {
  /** Record id currently linked to `node` on `resolver`, if a Linked was seen. */
  linkOf(resolver: Hex, node: Hex): Promise<bigint | undefined>;
  putLink(resolver: Hex, node: Hex, recordId: bigint, name: Hex, stamp: Stamp): Promise<void>;
  /** Nodes currently linked to `recordId` on `resolver`. */
  linkedNodes(resolver: Hex, recordId: bigint): Promise<Hex[]>;
  recordValues(resolver: Hex, recordId: bigint): Promise<(RecordValue & { key: string })[]>;
  putRecordValue(resolver: Hex, recordId: bigint, key: string, value: RecordValue): Promise<void>;
  /** ens_records(node, key) */
  putNodeRecord(node: Hex, key: string, resolver: Hex, value: RecordValue): Promise<void>;
  /** Drop ens_records rows of `node` that came from `resolver`. */
  clearNodeRecords(node: Hex, resolver: Hex): Promise<void>;
  /** Whether records of `node` on `resolver` may be projected (the collector-resolver own-node guard). */
  acceptsNode(resolver: Hex, node: Hex): Promise<boolean>;
}

/**
 * A record write. The value is always kept by record id; with no linked node yet (a Linked we never saw, for example
 * a resolver whose record predates the start block) it is not projected, but a later Linked to that id projects it.
 */
export async function writeRecord(store: ResolverRecordStore, resolver: Hex, recordId: bigint, key: string, value: RecordValue) {
  await store.putRecordValue(resolver, recordId, key, value);
  const nodes = await store.linkedNodes(resolver, recordId);
  if (nodes.length === 0) {
    console.warn(`resolver ${resolver}: record ${recordId} "${key}" written with no linked node; kept by record id`);
    return;
  }
  for (const node of nodes) if (await store.acceptsNode(resolver, node)) await store.putNodeRecord(node, key, resolver, value);
}

/** Project every value of the record `node` links to onto ens_records, stamped with `stamp` if given. */
export async function projectNode(store: ResolverRecordStore, resolver: Hex, node: Hex, stamp?: Stamp) {
  const recordId = await store.linkOf(resolver, node);
  if (recordId === undefined || isUnlink(recordId)) return;
  if (!(await store.acceptsNode(resolver, node))) return;
  for (const { key, ...value } of await store.recordValues(resolver, recordId)) {
    await store.putNodeRecord(node, key, resolver, stamp ? { ...value, ...stamp } : value);
  }
}

/** Linked(recordId, node, name): the node now reads `recordId` (0: no record of its own). */
export async function linkNode(store: ResolverRecordStore, resolver: Hex, recordId: bigint, node: Hex, name: Hex, stamp: Stamp) {
  const previous = await store.linkOf(resolver, node);
  await store.putLink(resolver, node, recordId, name, stamp);
  // Moving to another record (or unlinking) replaces what the node resolves to, so its old values must not linger.
  if (previous !== undefined && previous !== recordId) await store.clearNodeRecords(node, resolver);
  await projectNode(store, resolver, node, stamp);
}
