import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cached: [] as { scryfallId: string }[],
  vault: [] as string[],
  dbFail: false,
  ponderFail: false,
  fetched: [] as string[],
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const row = (id: string) => ({
  scryfallId: id, setCode: "lea", setName: "Alpha", rarity: "rare", colors: [], lang: "en", prices: { usd: "1.00" },
  raw: { artist: "A" }, name: `card ${id}`, imageNormal: "https://img/n.jpg",
});

vi.mock("@/lib/db/client", () => {
  const chain = {
    from: () => chain,
    where: async () => {
      if (state.dbFail) throw new Error("db down");
      return state.cached.map((c) => row(c.scryfallId));
    },
  };
  return { getDb: () => ({ select: () => chain }) };
});
vi.mock("@/lib/ponder-server", async () => {
  const schema = await import("../../indexer/ponder.schema");
  const chain = {
    from: () => chain,
    where: async () => {
      if (state.ponderFail) throw new Error("indexer down");
      return state.vault.map((scryfallId) => ({ scryfallId }));
    },
  };
  return { schema, ponderServer: () => ({ db: { select: () => chain } }) };
});
vi.mock("@/lib/scryfall", () => ({
  scryfall: () => ({
    getById: async (id: string) => {
      state.fetched.push(id);
      return { setCode: "lea", setName: "Alpha", rarity: "rare", lang: "en", prices: { usd: "2.00" }, name: `fetched ${id}`, image: "i" };
    },
  }),
}));

import { GET } from "@/app/api/cards/attributes/route";

const call = (ids: string) => GET(new Request(`http://x/api/cards/attributes?ids=${ids}`));

describe("GET /api/cards/attributes", () => {
  beforeEach(() => {
    state.cached = [];
    state.vault = [];
    state.dbFail = false;
    state.ponderFail = false;
    state.fetched = [];
  });

  it("rejects ids that are not Scryfall UUIDs, and more than 100 ids", async () => {
    expect((await call("not-a-uuid")).status).toBe(400);
    expect((await call(`${uuid(1)},../../etc`)).status).toBe(400);
    expect((await call(Array.from({ length: 101 }, (_, i) => uuid(i)).join(","))).status).toBe(400);
    expect((await call(Array.from({ length: 100 }, (_, i) => uuid(i)).join(","))).status).toBe(200);
  });

  it("serves cached ids, and fetches only uncached ids that are vault cards", async () => {
    state.cached = [{ scryfallId: uuid(1) }];
    state.vault = [uuid(2)];
    const body = await (await call([uuid(1), uuid(2), uuid(3)].join(","))).json();
    expect(body[uuid(1)].name).toBe(`card ${uuid(1)}`);
    expect(body[uuid(2)].name).toBe(`fetched ${uuid(2)}`);
    expect(body[uuid(3)]).toBeUndefined();
    expect(state.fetched).toEqual([uuid(2)]);
  });

  it("fetches at most 10 uncached cards per request", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => uuid(i));
    state.vault = ids;
    const body = await (await call(ids.join(","))).json();
    expect(state.fetched).toHaveLength(10);
    expect(Object.keys(body)).toHaveLength(10);
  });

  it("answers 503 when the app database is down, and fetches nothing when the indexer is", async () => {
    state.dbFail = true;
    const res = await call(uuid(1));
    expect(res.status).toBe(503);
    state.dbFail = false;
    state.ponderFail = true;
    const ok = await call(uuid(1));
    expect(ok.status).toBe(200);
    expect(state.fetched).toEqual([]);
  });
});
