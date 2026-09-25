import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/db/migrate";
import { Scryfall, ScryfallUnavailableError } from "@/lib/scryfall";

const lotus = {
  object: "card", id: "bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd", name: "Black Lotus", lang: "en", set: "lea",
  set_name: "Limited Edition Alpha", collector_number: "232", rarity: "rare", colors: [], type_line: "Artifact", cmc: 0,
  released_at: "1993-08-05", image_uris: { small: "https://img/s.jpg", normal: "https://img/n.jpg", png: "https://img/p.png" },
  prices: { usd: "25000.00", usd_foil: null, eur: "20000.00" }, finishes: ["nonfoil"],
};
const fireIce = {
  object: "card", id: "f1", name: "Fire // Ice", lang: "en", set: "apc", set_name: "Apocalypse", collector_number: "128",
  rarity: "uncommon", colors: ["R", "U"], type_line: "Instant // Instant", cmc: 2, released_at: "2001-06-04",
  card_faces: [{ name: "Fire", image_uris: { small: "https://img/fire-s.jpg", normal: "https://img/fire.jpg" } }, { name: "Ice", image_uris: { normal: "https://img/ice.jpg" } }],
  prices: { usd: "1.20", usd_foil: "5.00", eur: null }, finishes: ["nonfoil", "foil"],
};
const bolt = { ...lotus, id: "b1", name: "Lightning Bolt", printed_name: "稲妻", lang: "ja", set: "m21", set_name: "Core Set 2021", collector_number: "199", rarity: "uncommon" };

function fakeFetch(handler: (url: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("Scryfall", () => {
  beforeEach(async () => {
    await createTestDb();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("resolves a fuzzy name with set pin into a candidate with slug and setCode", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: lotus }));
    const s = new Scryfall({ fetchImpl: fn });
    const p = s.named({ name: "black lotus", set: "LEA" });
    await vi.runAllTimersAsync();
    const c = await p;
    expect(c?.scryfallId).toBe(lotus.id);
    expect(c?.slug).toBe("black-lotus");
    expect(c?.setCode).toBe("lea");
    expect(c?.image).toBe("https://img/p.png");
    expect(c?.prices.usd).toBe("25000.00");
    expect(calls[0]).toContain("/cards/named?");
    expect(calls[0]).toContain("fuzzy=black+lotus");
    expect(calls[0]).toContain("set=lea");
  });

  it("uses the first face image for split cards and slugs the full name", async () => {
    const { fn } = fakeFetch(() => ({ status: 200, body: fireIce }));
    const s = new Scryfall({ fetchImpl: fn });
    const p = s.named({ name: "Fire // Ice" });
    await vi.runAllTimersAsync();
    const c = await p;
    expect(c?.image).toBe("https://img/fire.jpg");
    expect(c?.imageSmall).toBe("https://img/fire-s.jpg");
    expect(c?.slug).toBe("fire-ice");
  });

  it("searches localized printings when lang is not en", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: { object: "list", data: [bolt] } }));
    const s = new Scryfall({ fetchImpl: fn });
    const p = s.named({ name: "Lightning Bolt", set: "m21", lang: "ja" });
    await vi.runAllTimersAsync();
    const c = await p;
    expect(c?.printedName).toBe("稲妻");
    expect(c?.lang).toBe("ja");
    expect(decodeURIComponent(calls[0])).toContain('!"Lightning Bolt" set:m21 lang:ja unique:prints');
  });

  it("returns null on 404 and throws ScryfallUnavailableError on 429", async () => {
    const notFound = new Scryfall({ fetchImpl: fakeFetch(() => ({ status: 404, body: { object: "error" } })).fn });
    const p1 = notFound.named({ name: "nothing" });
    await vi.runAllTimersAsync();
    expect(await p1).toBeNull();

    const limited = new Scryfall({ fetchImpl: fakeFetch(() => ({ status: 429, body: {} })).fn });
    const p2 = limited.named({ name: "x" }).catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await p2).toBeInstanceOf(ScryfallUnavailableError);
  });

  it("spaces requests by at least 500 ms", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: lotus }));
    const s = new Scryfall({ fetchImpl: fn });
    const a = s.getById("a");
    const b = s.getById("b");
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(2);
    await Promise.all([a, b]);
  });

  it("serves a second lookup of the same id from the cache without fetching", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: lotus }));
    const s = new Scryfall({ fetchImpl: fn });
    const p1 = s.getById(lotus.id);
    await vi.runAllTimersAsync();
    await p1;
    const p2 = s.getById(lotus.id);
    await vi.runAllTimersAsync();
    const c = await p2;
    expect(c?.name).toBe("Black Lotus");
    expect(calls).toHaveLength(1);
  });
});
