import { describe, expect, it } from "vitest";
import { MbShapeError } from "@/lib/multibaas/figures";
import { RECENT_LIMIT, fullDayCoveredAt, recentFromRows, recentFromWire, recentToWire } from "@/lib/multibaas/recent";

const H = 3600;
const since = Date.UTC(2026, 8, 26, 9, 2) / 1000; // the live link: block 11785122, ~09:02 UTC
const coverage = { startBlock: 11_785_122, since, fromDeploy: false };
const empty = { settles: [], redeems: [], mints: [], fees: [] };
const iso = (t: number) => new Date(t * 1000).toISOString();

describe("recentFromRows", () => {
  it("keeps the newest RECENT_LIMIT events across the four queries, exact amounts", () => {
    const mints = Array.from({ length: 12 }, (_, i) => ({ at: iso(since + i * 60), block: 11_785_200 + i, tx: `0x${(i + 1).toString(16)}`, card: String(i + 1) }));
    const settles = [{ at: iso(since + H), block: 11_786_000, tx: "0xff", card: "3", raised: "115792089237316195423570985008687907853269984665640564039457584007913129639935", fee: "0", graduated: "false" }];
    const r = recentFromRows({ ...empty, mints, settles }, coverage);
    expect(r.total).toBe(13);
    expect(r.events).toHaveLength(RECENT_LIMIT);
    expect(r.events[0]).toMatchObject({ kind: "settle", card: 3n, graduated: false, amount: 2n ** 256n - 1n });
    expect(r.events.slice(1).map((e) => e.card)).toEqual([12n, 11n, 10n, 9n, 8n, 7n, 6n, 5n, 4n]);
    const back = recentFromWire(JSON.parse(JSON.stringify(recentToWire(r))));
    expect(back).toEqual(r);
  });

  it("refuses a row of another shape, anywhere", () => {
    const bad = [
      { ...empty, mints: [{ at: iso(since), block: 1, tx: "0x1", card: "1.5" }] },
      { ...empty, mints: [{ at: iso(since), block: -1, tx: "0x1", card: "1" }] },
      { ...empty, mints: [{ at: iso(since), block: 1, tx: "hash", card: "1" }] },
      { ...empty, fees: [{ at: iso(since), block: 1, tx: "0x1", card: "1", kind: "2", amount: "5" }] },
      { ...empty, redeems: [{ at: iso(since), block: 1, tx: "0x1", card: "1", payout: 1.5 }] },
    ];
    for (const rows of bad) expect(() => recentFromRows(rows, coverage), JSON.stringify(rows)).toThrow(MbShapeError);
  });

  it("the wire refuses numeric amounts and unknown kinds", () => {
    const ok = recentToWire(recentFromRows({ ...empty, fees: [{ at: iso(since), block: 1, tx: "0x1", card: "1", kind: "0", amount: "5" }] }, coverage));
    expect(recentFromWire(ok)?.events[0]).toMatchObject({ kind: "fee", feeKind: "sale", amount: 5n });
    expect(recentFromWire({ ...ok, events: [{ ...ok.events[0]!, amount: 5 }] })).toBeNull();
    expect(recentFromWire({ ...ok, events: [{ ...ok.events[0]!, kind: "bid" }] })).toBeNull();
    expect(recentFromWire({ error: { code: "UNAVAILABLE" } })).toBeNull();
  });
});

describe("fullDayCoveredAt", () => {
  it("is the first whole hour whose 24h window starts after the link", () => {
    expect(fullDayCoveredAt(coverage)).toBe(Date.UTC(2026, 8, 27, 9, 0) / 1000);
    expect(fullDayCoveredAt({ ...coverage, since: Date.UTC(2026, 8, 26, 9, 0) / 1000 })).toBe(Date.UTC(2026, 8, 27, 8, 0) / 1000);
    expect(fullDayCoveredAt({ ...coverage, fromDeploy: true })).toBeNull();
  });
});
