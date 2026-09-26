import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { linkNode, projectNode, type RecordValue, type ResolverRecordStore, writeRecord } from "../src/lib/resolver-records";

// In-memory ResolverRecordStore, mirroring the ens_record_links / ens_resolver_records / ens_records tables.
function memoryStore(accepts: (resolver: Hex, node: Hex) => boolean = () => true) {
  const links = new Map<string, bigint>();
  const values = new Map<string, Map<string, RecordValue>>();
  const nodeRecords = new Map<string, RecordValue & { resolver: Hex }>();
  const store: ResolverRecordStore = {
    linkOf: async (r, n) => links.get(`${r}|${n}`),
    putLink: async (r, n, id) => void links.set(`${r}|${n}`, id),
    linkedNodes: async (r, id) => [...links].filter(([k, v]) => k.startsWith(`${r}|`) && v === id).map(([k]) => k.split("|")[1] as Hex),
    recordValues: async (r, id) => [...(values.get(`${r}|${id}`) ?? [])].map(([key, v]) => ({ key, ...v })),
    putRecordValue: async (r, id, key, v) => {
      const m = values.get(`${r}|${id}`) ?? new Map();
      m.set(key, v);
      values.set(`${r}|${id}`, m);
    },
    putNodeRecord: async (n, key, resolver, v) => void nodeRecords.set(`${n}|${key}`, { ...v, resolver }),
    clearNodeRecords: async (n, r) => {
      for (const [k, v] of nodeRecords) if (k.startsWith(`${n}|`) && v.resolver === r) nodeRecords.delete(k);
    },
    acceptsNode: async (r, n) => accepts(r, n),
  };
  const read = (node: Hex, key: string) => nodeRecords.get(`${node}|${key}`)?.value;
  const keysOf = (node: Hex) => [...nodeRecords.keys()].filter((k) => k.startsWith(`${node}|`)).map((k) => k.split("|")[1]).sort();
  return { store, read, keysOf };
}

const R: Hex = "0x00000000000000000000000000000000000000aa";
const OTHER_R: Hex = "0x00000000000000000000000000000000000000bb";
const CARD: Hex = `0x${"c".repeat(64)}`;
const ALIAS: Hex = `0x${"a".repeat(64)}`;
const NAME: Hex = "0x0463617264046b75726103657468" + "00" as Hex;
const setBy: Hex = "0x00000000000000000000000000000000000000ee";
const at = (block: bigint) => ({ updatedBlock: block, updatedAt: Number(block) * 12 });
const v = (value: string, block = 1n): RecordValue => ({ value, setBy, ...at(block) });

describe("ENSv2 resolver records", () => {
  beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => {}));

  it("projects a write onto the node its first Linked named (Linked precedes the setter's event)", async () => {
    const { store, read } = memoryStore();
    await linkNode(store, R, 1n, CARD, NAME, at(1n));
    await writeRecord(store, R, 1n, "avatar", v("ipfs://x"));
    await writeRecord(store, R, 1n, "addr", v("0xholder"));
    expect(read(CARD, "avatar")).toBe("ipfs://x");
    expect(read(CARD, "addr")).toBe("0xholder");
  });

  it("keeps a write with no linked node by record id and projects it once a Linked arrives", async () => {
    const { store, read, keysOf } = memoryStore();
    await writeRecord(store, R, 7n, "avatar", v("ipfs://early"));
    expect(keysOf(CARD)).toEqual([]);
    expect(console.warn).toHaveBeenCalledOnce();
    await linkNode(store, R, 7n, CARD, NAME, at(2n));
    expect(read(CARD, "avatar")).toBe("ipfs://early");
  });

  it("fans a write out to every node linked to the same record (aliases)", async () => {
    const { store, read } = memoryStore();
    await linkNode(store, R, 1n, CARD, NAME, at(1n));
    await writeRecord(store, R, 1n, "avatar", v("ipfs://x"));
    await linkNode(store, R, 1n, ALIAS, NAME, at(2n)); // linkToNode(alias, CARD)
    expect(read(ALIAS, "avatar")).toBe("ipfs://x");
    await writeRecord(store, R, 1n, "avatar", v("ipfs://y", 3n));
    expect(read(CARD, "avatar")).toBe("ipfs://y");
    expect(read(ALIAS, "avatar")).toBe("ipfs://y");
  });

  it("replaces a node's records when it moves to another record, and clears them on unlink", async () => {
    const { store, read, keysOf } = memoryStore();
    await linkNode(store, R, 1n, CARD, NAME, at(1n));
    await writeRecord(store, R, 1n, "avatar", v("one"));
    await writeRecord(store, R, 1n, "url", v("https://one"));
    await linkNode(store, R, 2n, ALIAS, NAME, at(2n));
    await writeRecord(store, R, 2n, "avatar", v("two"));
    await linkNode(store, R, 2n, CARD, NAME, at(3n)); // linkToRecord(card, 2)
    expect(read(CARD, "avatar")).toBe("two");
    expect(read(CARD, "url")).toBeUndefined();
    await writeRecord(store, R, 1n, "avatar", v("one again")); // the old record no longer reaches CARD
    expect(read(CARD, "avatar")).toBe("two");
    await linkNode(store, R, 0n, CARD, NAME, at(4n)); // linkToRecord(card, 0)
    expect(keysOf(CARD)).toEqual([]);
    expect(read(ALIAS, "avatar")).toBe("two");
  });

  it("keeps record ids apart per resolver", async () => {
    const { store, read } = memoryStore();
    await linkNode(store, R, 1n, CARD, NAME, at(1n));
    await linkNode(store, OTHER_R, 1n, ALIAS, NAME, at(1n));
    await writeRecord(store, OTHER_R, 1n, "avatar", v("other"));
    expect(read(CARD, "avatar")).toBeUndefined();
    expect(read(ALIAS, "avatar")).toBe("other");
  });

  it("does not project nodes the guard rejects, and projects them later once accepted", async () => {
    let known = false; // the collector row appears with CollectorNamed, after the resolver's initialize() writes
    const { store, read } = memoryStore((_r, n) => known && n === CARD);
    await linkNode(store, R, 1n, CARD, NAME, at(1n));
    await writeRecord(store, R, 1n, "addr", v("0xcollector"));
    await linkNode(store, R, 2n, ALIAS, NAME, at(1n));
    await writeRecord(store, R, 2n, "addr", v("0xspoof"));
    expect(read(CARD, "addr")).toBeUndefined();
    known = true;
    await projectNode(store, R, CARD, at(5n));
    expect(read(CARD, "addr")).toBe("0xcollector");
    await writeRecord(store, R, 2n, "addr", v("0xspoof2"));
    expect(read(ALIAS, "addr")).toBeUndefined();
  });
});
