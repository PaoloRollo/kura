/**
 * Polite Scryfall access for the offline scripts: a descriptive User-Agent and Accept header,
 * at most ~10 req/s to api.scryfall.com, bounded concurrency on the image CDN, retry with backoff.
 */
export const USER_AGENT = "Kura/0.1 (hackathon card index builder)";
const API_SPACING_MS = 100;

let apiQueue: Promise<void> = Promise.resolve();
let apiLastAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with retries on network errors, 429 and 5xx (exponential backoff, honours Retry-After). */
export async function fetchWithRetry(url: string, accept: string, retries = 4): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let error: unknown = null;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: accept } });
    } catch (e) {
      error = e;
    }
    if (res && res.status !== 429 && res.status < 500) return res;
    if (attempt >= retries) {
      if (res) return res;
      throw error;
    }
    const retryAfter = Number(res?.headers.get("retry-after"));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt + Math.random() * 250;
    await res?.body?.cancel().catch(() => undefined);
    await sleep(backoff);
  }
}

/** A JSON GET against api.scryfall.com, serialised and spaced to stay under 10 req/s. */
export async function scryfallApi<T>(pathOrUrl: string): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.scryfall.com${pathOrUrl}`;
  const run = async () => {
    const wait = apiLastAt + API_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    apiLastAt = Date.now();
    const res = await fetchWithRetry(url, "application/json");
    if (!res.ok) throw new Error(`scryfall ${res.status} for ${url}`);
    return (await res.json()) as T;
  };
  const result = apiQueue.then(run, run);
  apiQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Download an image from cards.scryfall.io into memory. */
export async function fetchImage(url: string): Promise<Buffer> {
  const res = await fetchWithRetry(url, "image/*");
  if (!res.ok) throw new Error(`image ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Run fn over items with at most `concurrency` in flight; results keep input order. */
export async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
