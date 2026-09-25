import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: getMock }));

import { getCardIndex, IndexUnavailableError, loadCardIndexFromUrl } from "@/lib/card-index";
import { setUserForTests } from "@/lib/auth";
import { createTestDb } from "@/lib/db/migrate";
import deployments from "@/generated/deployments.json";
import { POST as matchRoute } from "@/app/api/scan/match/route";

const FIXTURE = join(__dirname, "fixtures/card-index");
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURE, name)));
const PRIVATE = "https://abc123.private.blob.vercel-storage.com/card-index/test";
const PUBLIC_LOOKING = "https://blob.example/card-index/private-by-env";
let n = 0;
const fresh = (base = PRIVATE) => `${base}-${++n}`;
const plainFiles = () => ({ "manifest.json": fixture("manifest.json"), "meta.json": fixture("meta.json"), "vectors.bin": fixture("vectors.bin") });

/** Fake `get` from @vercel/blob: serves `files` by basename as a stream, null (its 404) for anything else. */
function serveBlobs(files: Record<string, Uint8Array | string>) {
  getMock.mockReset();
  getMock.mockImplementation(async (url: string) => {
    const body = files[url.slice(url.lastIndexOf("/") + 1)];
    if (body === undefined) return null;
    return { statusCode: 200, stream: new Response(typeof body === "string" ? body : body.slice()).body, headers: new Headers(), blob: { url } };
  });
}

beforeEach(() => {
  process.env.CARD_INDEX_DIR = "/no/such/card-index-dir";
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
  // Public URLs use plain fetch; the private path must never touch it.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch must not be used for a private store"); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ["CARD_INDEX_URL", "CARD_INDEX_DIR", "CARD_INDEX_BLOB_ACCESS", "BLOB_READ_WRITE_TOKEN"]) delete process.env[k];
});

describe("card index from a private Vercel Blob store", () => {
  it("reads each file through @vercel/blob get with the store token when the URL is a private store", async () => {
    const base = fresh();
    serveBlobs(plainFiles());
    process.env.CARD_INDEX_URL = base;
    const index = await getCardIndex();
    expect(index.meta).toEqual(JSON.parse(readFileSync(join(FIXTURE, "meta.json"), "utf8")));
    expect(index.vectors.count).toBe(index.manifest.count);
    const urls = getMock.mock.calls.map(([u]) => u);
    expect(urls).toEqual(expect.arrayContaining([`${base}/manifest.json`, `${base}/meta.json.gz`, `${base}/meta.json`, `${base}/vectors.bin`]));
    for (const [, opts] of getMock.mock.calls) {
      expect(opts).toMatchObject({ access: "private", token: "vercel_blob_rw_test_token" });
      expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    }
  });

  it("uses the private path when CARD_INDEX_BLOB_ACCESS=private, whatever the host", async () => {
    process.env.CARD_INDEX_URL = fresh(PUBLIC_LOOKING);
    process.env.CARD_INDEX_BLOB_ACCESS = "private";
    serveBlobs(plainFiles());
    await getCardIndex();
    expect(getMock).toHaveBeenCalled();
  });

  it("gunzips meta.json.gz read from the private store", async () => {
    const base = fresh();
    process.env.CARD_INDEX_URL = base;
    serveBlobs({ "manifest.json": fixture("manifest.json"), "meta.json.gz": gzipSync(fixture("meta.json")), "vectors.bin": fixture("vectors.bin") });
    const index = await getCardIndex();
    expect(index.meta.length).toBe(index.manifest.count);
    expect(getMock.mock.calls.map(([u]) => u)).not.toContain(`${base}/meta.json`);
  });

  it("reads the store once for concurrent first callers", async () => {
    process.env.CARD_INDEX_URL = fresh();
    serveBlobs(plainFiles());
    const [a, b] = await Promise.all([getCardIndex(), getCardIndex()]);
    expect(b).toBe(a);
    expect(await getCardIndex()).toBe(a);
    expect(getMock.mock.calls.filter(([u]) => String(u).endsWith("/manifest.json"))).toHaveLength(1);
  });

  it("does not cache a failure, so a later request retries", async () => {
    process.env.CARD_INDEX_URL = fresh();
    getMock.mockReset();
    getMock.mockRejectedValue(new Error("Vercel Blob: Failed to fetch blob: 500"));
    await expect(getCardIndex()).rejects.toBeInstanceOf(IndexUnavailableError);
    serveBlobs(plainFiles());
    expect((await getCardIndex()).vectors.count).toBeGreaterThan(0);
  });

  it("gives up with IndexUnavailableError when the store does not answer in time", async () => {
    getMock.mockReset();
    getMock.mockImplementation((_: string, opts: { abortSignal: AbortSignal }) => new Promise((_, reject) => {
      opts.abortSignal.addEventListener("abort", () => reject(opts.abortSignal.reason));
    }));
    await expect(loadCardIndexFromUrl(fresh(), 20)).rejects.toThrow(/timed out/);
  });
});

describe("POST /api/scan/match with a private Blob store", () => {
  beforeEach(async () => {
    await createTestDb();
    setUserForTests({ did: "did:vendor", wallet: deployments.vendor as `0x${string}` });
  });

  it("answers 503 INDEX_UNAVAILABLE and logs why when BLOB_READ_WRITE_TOKEN is missing", async () => {
    process.env.CARD_INDEX_URL = fresh();
    delete process.env.BLOB_READ_WRITE_TOKEN;
    serveBlobs(plainFiles());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await matchRoute(new Request("http://localhost/api/scan/match", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vector: [0] }) }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("INDEX_UNAVAILABLE");
    expect(getMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/BLOB_READ_WRITE_TOKEN is not set/));
  });
});
