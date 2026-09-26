import { describe, expect, it } from "vitest";
import { MbShapeError, baseUnits, figuresFromRows, flag, fromWire, toWire, unixSeconds, type MbRows } from "@/lib/multibaas/figures";

const H = 3600;
const D = 86_400;
const now = Date.UTC(2026, 8, 26, 14, 37) / 1000; // Sat 2026-09-26 14:37 UTC
const iso = (t: number) => new Date(t * 1000).toISOString();

// The same vault as test/analytics-view.test.ts: 5,136 raised 2 days ago, a reserve-not-met settle, 7,000 raised
// 10 days ago, a 1,000 buyout 3 hours ago; fees 128.40 (sale) and 25 (buyout), and 50 ten days ago.
const rows = (): MbRows => ({
  settles: [
    { at: iso(now - 2 * D), block: 100, tx: "0x01", card: "1", raised: "5136000000", fee: "128400000", graduated: true },
    { at: iso(now - 2 * D), block: 101, tx: "0x02", card: "2", raised: "0", fee: "0", graduated: false },
    { at: iso(now - 10 * D), block: 50, tx: "0x03", card: "6", raised: "7000000000", fee: "50000000", graduated: "true" },
  ],
  redeems: [{ at: iso(now - 3 * H), block: 120, tx: "0x04", card: "1", payout: "1000000000", fee: "25000000" }],
  mints: [{ at: iso(now - 30 * D), block: 10, tx: "0x05", card: "1" }, { at: iso(now - H), block: 130, tx: "0x06", card: "7" }],
  fees: [
    { at: iso(now - 2 * D), block: 100, tx: "0x01", card: "1", kind: "0", amount: "128400000" },
    { at: iso(now - 3 * H), block: 120, tx: "0x04", card: "1", kind: "1", amount: "25000000" },
    { at: iso(now - 10 * D), block: 50, tx: "0x03", card: "6", kind: "0", amount: "50000000" },
  ],
  raisedTotal: [{ vault: "kura_vault", raised: "12136000000" }],
  feesTotal: [{ vault: "kura_vault", fees: 203_400_000 }],
});

describe("base-unit parsing", () => {
  it("keeps integer amounts exact, a uint256 included", () => {
    expect(baseUnits("96420000000", "raised")).toBe(96_420_000_000n);
    const max = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    expect(baseUnits(max, "raised").toString()).toBe(max);
    expect(baseUnits(12, "raised")).toBe(12n);
    expect(baseUnits(Number.MAX_SAFE_INTEGER, "raised")).toBe(9_007_199_254_740_991n);
  });

  it("refuses anything that could already have lost precision or carries decimals", () => {
    for (const v of ["123.456", "1e21", "-5", "", " 5", "5 ", "0x10", "+5", 1.5, -1, 2 ** 53, 1e21, NaN, Infinity, null, undefined, true, 5n, {}, []]) {
      expect(() => baseUnits(v, "raised"), String(v)).toThrow(MbShapeError);
    }
  });

  it("refuses a JSON number past 2^53, the lossy float res.json() hands back", () => {
    // 9007199254740993 is not representable: JSON.parse rounds it to 9007199254740992 without a word.
    const body = JSON.parse('{"raised": 9007199254740993, "fees": 96420000000000000000}') as { raised: unknown; fees: unknown };
    expect(body.raised).toBe(9_007_199_254_740_992);
    expect(() => baseUnits(body.raised, "raised")).toThrow(/raised: expected a base-unit integer/);
    expect(() => baseUnits(body.fees, "fees")).toThrow(MbShapeError);
    // The same amount as a decimal string stays exact.
    expect(baseUnits(JSON.parse('"9007199254740993"'), "raised")).toBe(9_007_199_254_740_993n);
  });

  it("reads timestamps and booleans in the shapes MultiBaas may use", () => {
    expect(unixSeconds("2026-09-24T23:37:00+09:00")).toBe(Date.UTC(2026, 8, 24, 14, 37) / 1000);
    expect(unixSeconds("2026-09-24T14:37:00.123456Z")).toBe(Date.UTC(2026, 8, 24, 14, 37) / 1000);
    expect(unixSeconds(1_790_000_000)).toBe(1_790_000_000);
    // Postgres-style offsets and separators, and unix seconds as a digit string.
    const t = Date.UTC(2026, 8, 24, 14, 37) / 1000;
    expect(unixSeconds("2026-09-24 14:37:00+00")).toBe(t);
    expect(unixSeconds("2026-09-24 14:37:00.5+0000")).toBe(t);
    expect(unixSeconds("2026-09-24T23:37:00+0900")).toBe(t);
    expect(unixSeconds("2026-09-24T09:37:00-05")).toBe(t);
    expect(unixSeconds("1790000000")).toBe(1_790_000_000);
    expect(unixSeconds("0")).toBe(0);
    // Milliseconds are refused, as a number or a string, rather than read as a date in the year 58,000.
    for (const v of [1_790_000_000_000, "1790000000000", 1e11, "100000000000"]) {
      expect(() => unixSeconds(v), String(v)).toThrow(MbShapeError);
    }
    for (const v of ["yesterday", "Sep 24 2026", "2026-09-24", "2026-09-24T14:37:00+9", "2026-09-24T14:37:00+00:0", " 1790000000", "17.9", "", 1.5, -1, null]) {
      expect(() => unixSeconds(v), String(v)).toThrow(MbShapeError);
    }
    expect(flag(true, "g")).toBe(true);
    expect(flag("false", "g")).toBe(false);
    expect(() => flag(1, "g")).toThrow(MbShapeError);
  });
});

describe("figuresFromRows", () => {
  it("7d: graduated raised, fees and mints in the window, and daily volume = settle + redeem", () => {
    const f = figuresFromRows(rows(), "7d", now);
    expect(f).toMatchObject({ range: "7d", raised: 5_136_000_000n, raisedAuctions: 1, fees: 153_400_000n, mintedInRange: 1, totalMints: 2 });
    expect(f.window).toEqual({ from: Date.UTC(2026, 8, 20) / 1000, to: now, unit: "day" });
    expect(f.volume.map((b) => b.date)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"]);
    expect(f.volume.map((b) => b.volumeUsdc)).toEqual([0n, 0n, 0n, 0n, 5_136_000_000n, 0n, 1_000_000_000n]);
  });

  it("All: raised and fees from MultiBaas's add aggregates, from the first mint's day", () => {
    const f = figuresFromRows(rows(), "all", now);
    expect(f).toMatchObject({ raised: 12_136_000_000n, raisedAuctions: 2, fees: 203_400_000n, mintedInRange: 2, totalMints: 2 });
    expect(f.window.from).toBe(Date.UTC(2026, 7, 27) / 1000);
  });

  it("24h: 24 hourly buckets, the buyout in its hour", () => {
    const f = figuresFromRows(rows(), "24h", now);
    expect(f.volume).toHaveLength(24);
    expect(f.volume.find((b) => b.volumeUsdc > 0n)).toEqual({ date: "2026-09-26T11", volumeUsdc: 1_000_000_000n });
    expect(f).toMatchObject({ raised: 0n, raisedAuctions: 0, fees: 25_000_000n, mintedInRange: 1 });
  });

  it("answers zeros for an empty vault, and refuses a row it can't read", () => {
    const empty: MbRows = { settles: [], redeems: [], mints: [], fees: [], raisedTotal: [], feesTotal: [] };
    expect(figuresFromRows(empty, "all", now)).toMatchObject({ raised: 0n, fees: 0n, totalMints: 0 });
    expect(() => figuresFromRows({ ...rows(), raisedTotal: [{ vault: "kura_vault", raised: 2 ** 60 }] }, "all", now)).toThrow(MbShapeError);
    expect(() => figuresFromRows({ ...rows(), settles: [{ at: iso(now), raised: "5136.000000", graduated: true }] }, "7d", now)).toThrow(/raised/);
    // A bad row outside the window still refuses the whole answer: the window never hides a shape change.
    expect(() => figuresFromRows({ ...rows(), fees: [{ at: iso(now - 90 * D), amount: 1.25 }] }, "24h", now)).toThrow(/amount/);
  });
});

describe("wire format", () => {
  it("round-trips with amounts as strings", () => {
    const f = figuresFromRows(rows(), "7d", now);
    const wire = JSON.parse(JSON.stringify(toWire(f)));
    expect(wire.raised).toBe("5136000000");
    expect(wire.fees).toBe("153400000");
    expect(wire.volume[4]).toEqual({ date: "2026-09-24", volumeUsdc: "5136000000" });
    expect(wire.source).toBe("multibaas");
    expect(fromWire(wire)).toEqual(f);
  });

  it("keeps a uint256-sized amount exact across the wire", () => {
    const max = 2n ** 256n - 1n;
    const f = { ...figuresFromRows(rows(), "all", now), raised: max };
    expect(fromWire(JSON.parse(JSON.stringify(toWire(f))))?.raised).toBe(max);
  });

  it("rejects numbers for amounts and anything else malformed", () => {
    const wire = JSON.parse(JSON.stringify(toWire(figuresFromRows(rows(), "7d", now))));
    expect(fromWire({ ...wire, raised: 5136000000 })).toBeNull();
    expect(fromWire({ ...wire, fees: "153.4" })).toBeNull();
    expect(fromWire({ ...wire, volume: [{ date: "2026-09-26", volumeUsdc: 1 }] })).toBeNull();
    expect(fromWire({ ...wire, source: "indexer" })).toBeNull();
    expect(fromWire({ ...wire, range: "30d" })).toBeNull();
    expect(fromWire({ error: { code: "UNAVAILABLE" } })).toBeNull();
    expect(fromWire(null)).toBeNull();
  });
});
