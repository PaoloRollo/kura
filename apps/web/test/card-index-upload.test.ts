import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadCardIndex, type BlobPut } from "../scripts/lib/card-index-upload";

const FIXTURE = join(__dirname, "fixtures/card-index");
const STORE = "https://abc123.public.blob.vercel-storage.com";

/** A fake `put` that records every upload and answers the URL Vercel Blob would. */
function fakePut() {
  const uploads: { pathname: string; body: Buffer; options: Parameters<BlobPut>[2] }[] = [];
  const put: BlobPut = vi.fn(async (pathname, body, options) => {
    uploads.push({ pathname, body: Buffer.from(body as Buffer), options });
    return { url: `${STORE}/${pathname}`, pathname };
  });
  return { put, uploads };
}

describe("uploadCardIndex", () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("uploads manifest.json, a gzipped meta.json.gz and vectors.bin under one versioned prefix", async () => {
    const { put, uploads } = fakePut();
    const { baseUrl, prefix } = await uploadCardIndex(FIXTURE, put);

    const manifest = JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")) as { builtAt: string };
    const stamp = manifest.builtAt.replace(/[-:]|\.\d+/g, "");
    expect(prefix).toMatch(new RegExp(`^card-index/${stamp}-[0-9a-f]{8}$`));
    expect(baseUrl).toBe(`${STORE}/${prefix}`);

    expect(uploads.map((u) => u.pathname).sort()).toEqual([`${prefix}/manifest.json`, `${prefix}/meta.json.gz`, `${prefix}/vectors.bin`]);
    const by = (name: string) => uploads.find((u) => u.pathname.endsWith(`/${name}`))!;
    expect(by("manifest.json").body.equals(readFileSync(join(FIXTURE, "manifest.json")))).toBe(true);
    expect(gunzipSync(by("meta.json.gz").body).equals(readFileSync(join(FIXTURE, "meta.json")))).toBe(true);
    expect(by("vectors.bin").body.equals(readFileSync(join(FIXTURE, "vectors.bin")))).toBe(true);

    expect(by("manifest.json").options).toMatchObject({ access: "public", addRandomSuffix: false, contentType: "application/json" });
    expect(by("meta.json.gz").options).toMatchObject({ access: "public", addRandomSuffix: false, contentType: "application/gzip" });
    expect(by("vectors.bin").options).toMatchObject({ access: "public", addRandomSuffix: false, contentType: "application/octet-stream" });
  });

  it("uploads the manifest last, so a half-finished upload is never a loadable index", async () => {
    const { put, uploads } = fakePut();
    await uploadCardIndex(FIXTURE, put);
    expect(uploads.at(-1)!.pathname).toMatch(/\/manifest\.json$/);
  });

  it("gives the same prefix for the same index and a different one when the index changes", async () => {
    const a = await uploadCardIndex(FIXTURE, fakePut().put);
    const b = await uploadCardIndex(FIXTURE, fakePut().put);
    expect(b.prefix).toBe(a.prefix);

    tmp = mkdtempSync(join(tmpdir(), "card-index-upload-"));
    cpSync(FIXTURE, tmp, { recursive: true });
    const bin = readFileSync(join(tmp, "vectors.bin"));
    bin[bin.length - 1] ^= 1;
    writeFileSync(join(tmp, "vectors.bin"), bin);
    const c = await uploadCardIndex(tmp, fakePut().put);
    expect(c.prefix).not.toBe(a.prefix);
  });

  it("refuses a directory without an index before uploading anything", async () => {
    tmp = mkdtempSync(join(tmpdir(), "card-index-upload-"));
    cpSync(FIXTURE, tmp, { recursive: true });
    unlinkSync(join(tmp, "vectors.bin"));
    const { put, uploads } = fakePut();
    await expect(uploadCardIndex(tmp, put)).rejects.toThrow(/vectors\.bin/);
    expect(uploads).toEqual([]);
  });
});
