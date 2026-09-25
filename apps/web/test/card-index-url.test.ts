import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCardIndex, IndexUnavailableError, loadCardIndexFromUrl } from "@/lib/card-index";
import { setUserForTests } from "@/lib/auth";
import { createTestDb } from "@/lib/db/migrate";
import deployments from "@/generated/deployments.json";
import { POST as matchRoute } from "@/app/api/scan/match/route";

const FIXTURE = join(__dirname, "fixtures/card-index");
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURE, name)));
const BASE = "https://blob.example/card-index/test";
let n = 0;
/** A fresh base URL per test, since the loader caches per URL for the life of the module. */
const freshBase = () => `${BASE}-${++n}`;

/** Fake blob host: serves `files` under any base URL, 404 for anything else. Records every URL fetched. */
function serve(files: Record<string, Uint8Array | string>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const name = url.slice(url.lastIndexOf("/") + 1);
    const body = files[name];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(typeof body === "string" ? body : body.slice(), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const plainFiles = () => ({ "manifest.json": fixture("manifest.json"), "meta.json": fixture("meta.json"), "vectors.bin": fixture("vectors.bin") });

// Never fall back to the real index under data/card-index.
beforeEach(() => {
  process.env.CARD_INDEX_DIR = "/no/such/card-index-dir";
});

describe("card index from CARD_INDEX_URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CARD_INDEX_URL;
    delete process.env.CARD_INDEX_DIR;
  });

  it("loads and parses the index from the URL", async () => {
    const base = freshBase();
    const { calls } = serve(plainFiles());
    process.env.CARD_INDEX_URL = base;
    const index = await getCardIndex();
    const meta = JSON.parse(readFileSync(join(FIXTURE, "meta.json"), "utf8"));
    expect(index.meta).toEqual(meta);
    expect(index.vectors.count).toBe(meta.length);
    expect(index.manifest.count).toBe(meta.length);
    expect(calls).toContain(`${base}/manifest.json`);
    expect(calls).toContain(`${base}/vectors.bin`);
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const base = freshBase();
    const { calls } = serve(plainFiles());
    process.env.CARD_INDEX_URL = `${base}/`;
    await getCardIndex();
    expect(calls).toContain(`${base}/manifest.json`);
  });

  it("prefers a gzipped meta.json.gz and gunzips it", async () => {
    const base = freshBase();
    const { calls } = serve({ "manifest.json": fixture("manifest.json"), "meta.json.gz": gzipSync(fixture("meta.json")), "vectors.bin": fixture("vectors.bin") });
    process.env.CARD_INDEX_URL = base;
    const index = await getCardIndex();
    expect(index.meta).toEqual(JSON.parse(readFileSync(join(FIXTURE, "meta.json"), "utf8")));
    expect(calls).toContain(`${base}/meta.json.gz`);
    expect(calls).not.toContain(`${base}/meta.json`);
  });

  it("accepts a meta.json.gz the host already decoded (Content-Encoding: gzip)", async () => {
    process.env.CARD_INDEX_URL = freshBase();
    serve({ "manifest.json": fixture("manifest.json"), "meta.json.gz": fixture("meta.json"), "vectors.bin": fixture("vectors.bin") });
    const index = await getCardIndex();
    expect(index.meta.length).toBe(index.manifest.count);
  });

  it("fetches once for concurrent first callers and keeps the index in memory", async () => {
    process.env.CARD_INDEX_URL = freshBase();
    const { fetchMock } = serve(plainFiles());
    const [a, b, c] = await Promise.all([getCardIndex(), getCardIndex(), getCardIndex()]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    const afterFirst = fetchMock.mock.calls.length;
    expect(await getCardIndex()).toBe(a);
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
    const manifestFetches = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/manifest.json"));
    expect(manifestFetches).toHaveLength(1);
  });

  it("does not cache a failed load, so a later request retries", async () => {
    process.env.CARD_INDEX_URL = freshBase();
    serve({ "manifest.json": fixture("manifest.json") }); // meta and vectors missing
    await expect(getCardIndex()).rejects.toBeInstanceOf(IndexUnavailableError);
    serve(plainFiles());
    const index = await getCardIndex();
    expect(index.vectors.count).toBeGreaterThan(0);
  });

  it("turns a network error into IndexUnavailableError", async () => {
    process.env.CARD_INDEX_URL = freshBase();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(getCardIndex()).rejects.toBeInstanceOf(IndexUnavailableError);
  });

  it("gives up with IndexUnavailableError when the host does not answer in time", async () => {
    process.env.CARD_INDEX_URL = freshBase();
    vi.stubGlobal("fetch", vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })));
    await expect(loadCardIndexFromUrl(process.env.CARD_INDEX_URL, 20)).rejects.toBeInstanceOf(IndexUnavailableError);
  });

  it("rejects an index built with another recipe", async () => {
    process.env.CARD_INDEX_URL = freshBase();
    const manifest = JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
    serve({ ...plainFiles(), "manifest.json": JSON.stringify({ ...manifest, model: "someone/else" }) });
    await expect(getCardIndex()).rejects.toThrow(/different recipe/);
  });
});

describe("card index from CARD_INDEX_DIR with a gzipped meta", () => {
  let tmp: string;
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.CARD_INDEX_DIR;
  });

  it("reads meta.json.gz when meta.json is absent", async () => {
    tmp = mkdtempSync(join(tmpdir(), "card-index-gz-"));
    cpSync(FIXTURE, tmp, { recursive: true });
    writeFileSync(join(tmp, "meta.json.gz"), gzipSync(readFileSync(join(tmp, "meta.json"))));
    unlinkSync(join(tmp, "meta.json"));
    process.env.CARD_INDEX_DIR = tmp;
    const index = await getCardIndex();
    expect(index.meta).toEqual(JSON.parse(readFileSync(join(FIXTURE, "meta.json"), "utf8")));
  });
});

describe("POST /api/scan/match with CARD_INDEX_URL", () => {
  beforeEach(async () => {
    await createTestDb();
    setUserForTests({ did: "did:vendor", wallet: deployments.vendor as `0x${string}` });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CARD_INDEX_URL;
    delete process.env.CARD_INDEX_DIR;
  });

  it("answers 503 INDEX_UNAVAILABLE when the served index was built with another recipe", async () => {
    process.env.CARD_INDEX_URL = freshBase();
    const manifest = JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
    const { calls } = serve({ ...plainFiles(), "manifest.json": JSON.stringify({ ...manifest, image: "small" }) });
    const res = await matchRoute(new Request("http://localhost/api/scan/match", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vector: [0] }) }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("INDEX_UNAVAILABLE");
    expect(calls).toContain(`${process.env.CARD_INDEX_URL}/manifest.json`);
  });
});
