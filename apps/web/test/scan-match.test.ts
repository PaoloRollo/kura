import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/migrate";
import { setUserForTests } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { scanDrafts } from "@/lib/db/schema";
import deployments from "@/generated/deployments.json";
import type { CardIndexRow } from "@/lib/card-index-format";
import { decodeVectors, dequantize } from "@/lib/card-vectors";
import { clearPrintingsCacheForTests, type MatchCandidate } from "@/lib/card-match";
import { POST as matchRoute } from "@/app/api/scan/match/route";

const vendor = deployments.vendor as `0x${string}`;
const alice = "0x1111111111111111111111111111111111111111" as const;
const FIXTURE = join(__dirname, "fixtures/card-index");
const meta = JSON.parse(readFileSync(join(FIXTURE, "meta.json"), "utf8")) as CardIndexRow[];
const { dims } = JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")) as { dims: number };
const vectors = decodeVectors(new Uint8Array(readFileSync(join(FIXTURE, "vectors.bin"))), dims);
const rowVector = (i: number) => Array.from(dequantize(vectors.q.subarray(i * dims, (i + 1) * dims), vectors.scales[i]));

/** A Scryfall card for an index row; `over` makes siblings (other printings of the same art). */
function card(row: CardIndexRow, over: Record<string, unknown> = {}) {
  return {
    object: "card", id: row.scryfall_id, oracle_id: row.oracle_id, illustration_id: row.illustration_id, name: row.name, lang: row.lang,
    set: row.set, set_name: row.set.toUpperCase(), collector_number: row.collector_number, rarity: "rare", released_at: "1993-08-05",
    image_uris: { small: `https://img/${row.scryfall_id}-s.jpg`, normal: row.image }, prices: { usd: "1.00" }, finishes: ["nonfoil"], ...over,
  };
}

/** Fake api.scryfall.com: `printings` by exact name; names in `failing` answer 500. */
function stubScryfall(failing: Set<string> = new Set()) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const q = url.searchParams.get("q") ?? "";
    const name = /^!"(.*)" unique:prints lang:any$/.exec(q)?.[1];
    if (!name) return new Response("{}", { status: 404 });
    if (failing.has(name)) return new Response("{}", { status: 500 });
    const rows = meta.filter((r) => r.name === name);
    const data = rows.flatMap((r) => [
      card(r),
      card(r, { id: `${r.scryfall_id}-leb`, set: "leb", set_name: "Limited Edition Beta", released_at: "1993-10-04" }),
      card(r, { id: `${r.scryfall_id}-ja`, set: "4bb", set_name: "Fourth Edition Foreign Black Border", lang: "ja", printed_name: "日本語", released_at: "1995-04-01" }),
    ]);
    return new Response(JSON.stringify({ object: "list", data }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

const post = (body: unknown, raw?: string) =>
  new Request("http://localhost/api/scan/match", { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });

describe("POST /api/scan/match", () => {
  let tmp: string | null = null;
  beforeEach(async () => {
    await createTestDb();
    clearPrintingsCacheForTests();
    process.env.CARD_INDEX_DIR = FIXTURE;
    setUserForTests({ did: "did:vendor", wallet: vendor });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CARD_INDEX_DIR;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("returns the matched artwork first with its other printings as siblings, and stores an embedding draft", async () => {
    stubScryfall();
    const target = meta[7];
    const res = await matchRoute(post({ vector: rowVector(7) }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { draftId: string; confident: boolean; candidates: MatchCandidate[] };
    expect(out.confident).toBe(true);
    expect(out.candidates.length).toBeGreaterThan(1);
    const [top] = out.candidates;
    expect(top).toMatchObject({ scryfallId: target.scryfall_id, name: target.name, illustrationId: target.illustration_id, set: target.set });
    expect(top.score).toBeGreaterThan(0.99);
    expect(top.siblings.map((s) => [s.set, s.lang])).toEqual([[target.set, "en"], ["leb", "en"], ["4bb", "ja"]]);
    expect(top.siblings[2].printedName).toBe("日本語");
    for (let i = 1; i < out.candidates.length; i++) expect(out.candidates[i].score).toBeLessThanOrEqual(out.candidates[i - 1].score);
    expect(new Set(out.candidates.map((c) => c.illustrationId)).size).toBe(out.candidates.length);

    const [draft] = await getDb().select().from(scanDrafts).where(eq(scanDrafts.id, out.draftId));
    expect(draft.method).toBe("embedding");
    expect(draft.vendorWallet).toBe(vendor);
    expect(draft.candidates.map((c) => c.scryfallId)).toEqual(out.candidates.map((c) => c.scryfallId));
  });

  it("is not confident when two artworks score about the same", async () => {
    stubScryfall();
    const [a, b] = [rowVector(1), rowVector(2)];
    const res = await matchRoute(post({ vector: a.map((x, i) => x + b[i]) }));
    const out = (await res.json()) as { confident: boolean; candidates: MatchCandidate[] };
    expect(out.confident).toBe(false);
    expect(out.candidates.slice(0, 2).map((c) => c.scryfallId).sort()).toEqual([meta[1].scryfall_id, meta[2].scryfall_id].sort());
  });

  it("drops only the candidate whose Scryfall lookup fails", async () => {
    stubScryfall();
    const all = ((await (await matchRoute(post({ vector: rowVector(3) }))).json()) as { candidates: MatchCandidate[] }).candidates;
    const victim = all[1].name;
    clearPrintingsCacheForTests();
    stubScryfall(new Set([victim]));
    const res = await matchRoute(post({ vector: rowVector(3) }));
    expect(res.status).toBe(200);
    const some = ((await res.json()) as { candidates: MatchCandidate[] }).candidates;
    expect(some.map((c) => c.scryfallId)).toEqual(all.filter((c) => c.name !== victim).map((c) => c.scryfallId));
  });

  it("answers 503 when Scryfall is down for every candidate", async () => {
    stubScryfall(new Set(meta.map((r) => r.name)));
    const res = await matchRoute(post({ vector: rowVector(0) }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("SCRYFALL_UNAVAILABLE");
  });

  it("rejects a vector with the wrong number of dimensions or a non-finite value", async () => {
    stubScryfall();
    const short = await matchRoute(post({ vector: rowVector(0).slice(1) }));
    expect(short.status).toBe(400);
    expect((await short.json()).error.message).toMatch(new RegExp(`${dims}`));
    // 1e999 parses to Infinity.
    const inf = await matchRoute(post(null, `{"vector":[1e999${",0".repeat(dims - 1)}]}`));
    expect(inf.status).toBe(400);
    const nul = await matchRoute(post({ vector: [null, ...rowVector(0).slice(1)] }));
    expect(nul.status).toBe(400);
  });

  it("refuses non-vendors before reading the body", async () => {
    const calls = stubScryfall();
    setUserForTests({ did: "did:alice", wallet: alice });
    const req = post(null, "not json at all");
    const res = await matchRoute(req);
    expect(res.status).toBe(403);
    expect(req.bodyUsed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("answers 503 INDEX_UNAVAILABLE when the index is missing or was built with another recipe", async () => {
    stubScryfall();
    process.env.CARD_INDEX_DIR = join(tmpdir(), "no-such-card-index");
    const missing = await matchRoute(post({ vector: rowVector(0) }));
    expect(missing.status).toBe(503);
    expect((await missing.json()).error.code).toBe("INDEX_UNAVAILABLE");

    tmp = mkdtempSync(join(tmpdir(), "card-index-"));
    cpSync(FIXTURE, tmp, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(tmp, "manifest.json"), "utf8"));
    writeFileSync(join(tmp, "manifest.json"), JSON.stringify({ ...manifest, model: "someone/else" }));
    process.env.CARD_INDEX_DIR = tmp;
    const other = await matchRoute(post({ vector: rowVector(0) }));
    expect(other.status).toBe(503);
    expect((await other.json()).error.code).toBe("INDEX_UNAVAILABLE");
  });
});
