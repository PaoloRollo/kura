"use client";

import { CountdownHead } from "@/components/countdown";
import { useState } from "react";
import { usdcPerShardToQ96 } from "@kura/shared";
import { AnalyticsDashboard } from "@/components/analytics-dashboard";
import { useAnalytics } from "@/hooks/use-analytics";
import { analyticsView, withMultibaas, type AnalyticsCard, type AnalyticsInput, type AnalyticsRange } from "@/lib/analytics-view";
import type { RecentPanel } from "@/components/multibaas-recent";
import { figuresFromRows } from "@/lib/multibaas/figures";
import { recentFromRows, type RecentRows } from "@/lib/multibaas/recent";
import { CATALOG, HEAD, addr, blocksFromSeconds, usd, type CatalogKey } from "../catalog";
import { PreviewShell } from "../preview-shell";
import { ANALYTICS_PREVIEWS, type AnalyticsPreviewState } from "./states";


const H = 3600;
const D = 86_400;

type Spec = {
  id: number;
  name: string;
  key?: CatalogKey;
  lang?: string;
  state: AnalyticsCard["state"];
  mintedAgo: number;
  market: number | null;
  /** Sharded: final clearing per shard; auctioning: the latest checkpoint's (null before the first). */
  clearing?: number | null;
  shards?: number;
  graduated?: boolean | null;
  /** Auctioning: seconds until the end (negative once ended, awaiting settle). */
  endsIn?: number;
};

// Y1eNn's map: Black Lotus +9.6%, Mox 0%, Jace -18.5%, Time Walk +14.8%, Recall -7.2%, Force (live) +3.1%, Sol Ring
// +22.4%, Lightning Bolt · JA -3%; Wheel of Fortune has no clearing yet (n/a); Timetwister did not graduate (n/a);
// Library of Alexandria ended unsettled. Card #1's twin has no market price at all (left out of the map).
const MAPPED: Spec[] = [
  { id: 1, name: "Black Lotus", key: "lotus", state: "sharded", mintedAgo: 20 * D, market: 25_000, clearing: 1712, shards: 16 },
  { id: 2, name: "Mox Sapphire", key: "mox", state: "sharded", mintedAgo: 19 * D, market: 19_200, clearing: 1200, shards: 16 },
  { id: 3, name: "Jace, the Mind Sculptor", key: "jace", state: "sharded", mintedAgo: 18 * D, market: 1374, clearing: 17.5, shards: 64 },
  { id: 4, name: "Time Walk", key: "walk", state: "sharded", mintedAgo: 17 * D, market: 25_644.6, clearing: 1840, shards: 16 },
  { id: 5, name: "Ancestral Recall", key: "recall", state: "sharded", mintedAgo: 16 * D, market: 22_845, clearing: 662.5, shards: 32 },
  { id: 6, name: "Force of Will", key: "force", state: "auctioning", mintedAgo: 3 * D, market: 620.8, clearing: 40, shards: 16, endsIn: 252 },
  { id: 7, name: "Sol Ring", key: "solring", state: "sharded", mintedAgo: 15 * D, market: 336.6, clearing: 6.4375, shards: 64 },
  { id: 8, name: "Lightning Bolt · JA", lang: "ja", state: "auctioning", mintedAgo: 2 * D, market: 98.97, clearing: 6, shards: 16, endsIn: 3 * H },
  { id: 9, name: "Wheel of Fortune", state: "auctioning", mintedAgo: D, market: 1400, clearing: null, shards: 16, endsIn: 6 * H },
  { id: 10, name: "Timetwister", lang: "de", state: "sharded", mintedAgo: 12 * D, market: 900, clearing: 70, shards: 16, graduated: false },
  { id: 11, name: "Library of Alexandria", lang: "ja", state: "auctioning", mintedAgo: 9 * D, market: 1600, clearing: 105, shards: 16, endsIn: -600 },
  { id: 12, name: "Black Lotus", key: "lotus", lang: "it", state: "sharded", mintedAgo: 11 * D, market: null, clearing: null, shards: 16, graduated: false },
];
const WHOLE_LANGS = ["en", "en", "en", "en", "en", "en", "en", "en", "en", "ja", "ja", "ja", "de"];

function cardOf(s: Spec, now: number) {
  const label = `${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}-${s.id}`;
  return {
    id: BigInt(s.id), state: s.state, shardToken: s.state === "sharded" || s.state === "auctioning" ? addr(0x5a000 + s.id) : null,
    scryfallId: `fixture-${s.id}`, language: s.lang ?? "en", label: s.name, ensName: `${label}.kura.eth`, mintedAt: now - s.mintedAgo,
  } satisfies AnalyticsCard;
}

/** Daily volume like Y1eNn (oldest first): $4.2k, $11.8k, $7.1k, $15.4k, $9.6k, $21.3k, $27k. */
const DAILY = [4200, 11_800, 7100, 15_400, 9600, 21_300, 27_000];

type FixtureState = Exclude<AnalyticsPreviewState, "live" | "loading" | "multibaas" | "multibaas-new">;

const iso = (t: number) => new Date(t * 1000).toISOString();
const LINK_BLOCK = 11_785_122;
const tx = (n: number) => `0x${n.toString(16).padStart(4, "0").repeat(16)}`;

/** What MultiBaas holds in the `multibaas` preview: the last day's events, in the saved queries' row shape. */
function multibaasRows(now: number): RecentRows {
  const at = (ago: number) => ({ at: iso(now - ago), block: LINK_BLOCK + 7_500 - Math.round(ago / 12) });
  return {
    mints: [{ ...at(20 * H), tx: tx(1), card: "9" }, { ...at(40 * 60), tx: tx(2), card: "24" }],
    settles: [
      { ...at(13 * H), tx: tx(3), card: "7", raised: "2200000000", fee: "55000000", graduated: true },
      { ...at(8 * H), tx: tx(4), card: "10", raised: "0", fee: "0", graduated: false },
      { ...at(3 * H), tx: tx(5), card: "1", raised: "3400000000", fee: "85000000", graduated: true },
    ],
    redeems: [{ ...at(95 * 60), tx: tx(6), card: "4", payout: "1200000000", fee: "30000000" }],
    fees: [
      { ...at(13 * H), tx: tx(3), card: "7", kind: "0", amount: "55000000" },
      { ...at(3 * H), tx: tx(5), card: "1", kind: "0", amount: "85000000" },
      { ...at(95 * 60), tx: tx(6), card: "4", kind: "1", amount: "30000000" },
    ],
  };
}

/** The recent panel (and, for `multibaas`, the 24h figures) the route would answer in each MultiBaas preview. */
function multibaasFixture(state: "multibaas" | "multibaas-new", now: number, names: ReadonlyMap<string, string>) {
  const fresh = state === "multibaas-new";
  const rows: RecentRows = fresh ? { mints: [], settles: [], redeems: [], fees: [] } : multibaasRows(now);
  // Just linked: ~2.5 h ago at block 11,785,122. Otherwise linked two days ago, so the whole 24h window is covered.
  const since = fresh ? now - 2 * H - 35 * 60 : now - 2 * D;
  const recent: RecentPanel = { recent: recentFromRows(rows, { startBlock: LINK_BLOCK, since, fromDeploy: false }), names, now };
  const figures = fresh ? null : figuresFromRows({ ...rows, raisedTotal: [], feesTotal: [] }, "24h", now);
  return { recent, figures };
}

function fixture(state: FixtureState, now: number, range: AnalyticsRange): AnalyticsInput {
  if (state === "empty") {
    return { cards: [], shardings: [], active: [], checkpoints: [], activities: [], fees: [], collectors: 0, markets: new Map(), attributes: {}, block: HEAD, now, range };
  }
  const specs = [...MAPPED, ...WHOLE_LANGS.map((lang, i): Spec => ({ id: 20 + i, name: `Vault card ${20 + i}`, lang, state: "whole", mintedAgo: (i + 1) * 13 * H, market: 500 }))];
  const cards = specs.map((s) => cardOf(s, now));
  const shardings = MAPPED.map((s) => ({
    shardToken: addr(0x5a000 + s.id), cardId: BigInt(s.id), auction: addr(0xa0000 + s.id), totalShards: s.shards ?? 16,
    graduated: s.state === "auctioning" ? null : (s.graduated ?? true),
    clearingPriceQ96: s.state === "sharded" && s.clearing != null ? usdcPerShardToQ96(usd(s.clearing)) : null, createdAt: now - s.mintedAgo + H,
  }));
  const auctioning = MAPPED.filter((s) => s.state === "auctioning");
  const active = auctioning.map((s) => ({ auction: addr(0xa0000 + s.id), endBlock: HEAD + blocksFromSeconds(s.endsIn ?? 0) }));
  const checkpoints = auctioning.filter((s) => s.clearing != null).flatMap((s) => [
    { auction: addr(0xa0000 + s.id), blockNumber: HEAD - 40n, clearingPriceQ96: usdcPerShardToQ96(usd(s.clearing! * 0.9)) },
    { auction: addr(0xa0000 + s.id), blockNumber: HEAD - 2n, clearingPriceQ96: usdcPerShardToQ96(usd(s.clearing!)) },
  ]);
  const today = Math.floor(now / D) * D;
  // Each day: a graduated settle (most of the volume) and a buyout; plus a non-graduated settle that must not count.
  const quiet = state === "quiet-24h";
  const activities = DAILY.flatMap((v, i) => {
    const t = today - (6 - i) * D + 2 * H;
    const at = Math.min(t, now - 60) - (quiet ? 2 * D : 0);
    return [
      { kind: "settle", amount: usd(Math.round(v * 0.8)), actor: addr(1), timestamp: at, meta: { graduated: true } },
      { kind: "redeem", amount: usd(Math.round(v * 0.2)), actor: addr(2), timestamp: at + 60, meta: null },
    ];
  }).concat([{ kind: "settle", amount: usd(5000), actor: addr(1), timestamp: now - 3 * D, meta: { graduated: false } }]);
  // Some hours today for the 24h view.
  if (!quiet) for (const [h, v] of [[3, 1200], [8, 3400], [13, 2200]] as const) activities.push({ kind: "settle", amount: usd(v), actor: addr(3), timestamp: now - h * H, meta: { graduated: true } });
  const fees = activities.filter((a) => a.meta == null || (a.meta as { graduated?: boolean }).graduated !== false).map((a) => ({ amountUsdc: (a.amount * 250n) / 10_000n, timestamp: a.timestamp }));
  return {
    cards, shardings, active, checkpoints, activities, fees, collectors: 58,
    markets: new Map(specs.map((s) => [String(s.id), s.market == null ? null : usd(s.market)])),
    attributes: Object.fromEntries(specs.map((s) => [`fixture-${s.id}`, { name: s.name, image: s.key ? CATALOG[s.key].image : null }])),
    block: HEAD, now, range,
  };
}

function Live({ range, onRange }: { range: AnalyticsRange; onRange: (r: AnalyticsRange) => void }) {
  const data = useAnalytics(range);
  return <AnalyticsDashboard {...data} range={range} onRange={onRange} />;
}

function MultibaasPreview({ state, now, range, onRange }: { state: "multibaas" | "multibaas-new"; now: number; range: AnalyticsRange; onRange: (r: AnalyticsRange) => void }) {
  const input = fixture("rich", now, range);
  const names = new Map(input.cards.map((c) => [c.id.toString(), input.attributes[c.scryfallId]?.name || c.label]));
  const { recent, figures } = multibaasFixture(state, now, names);
  const view = withMultibaas(analyticsView(input), figures, range);
  return <AnalyticsDashboard view={view} isLoading={false} feeBps={250} range={range} onRange={onRange} recent={recent} multibaas24h={figures != null} />;
}

export function AnalyticsPreview({ state, now, initialRange }: { state: AnalyticsPreviewState; now: number; initialRange: AnalyticsRange }) {
  const [range, setRange] = useState<AnalyticsRange>(initialRange);
  return (
    <PreviewShell base="/design/analytics" states={ANALYTICS_PREVIEWS} state={state} path="/app/analytics">
      {state === "live" ? (
        <Live range={range} onRange={setRange} />
      ) : state === "loading" ? (
        <AnalyticsDashboard view={null} isLoading feeBps={null} range={range} onRange={setRange} />
      ) : (
        <CountdownHead.Provider value={{ number: HEAD, timestamp: now }}>
          {state === "multibaas" || state === "multibaas-new" ? (
            <MultibaasPreview state={state} now={now} range={range} onRange={setRange} />
          ) : (
            <AnalyticsDashboard view={analyticsView(fixture(state, now, range))} isLoading={false} feeBps={250} range={range} onRange={setRange} />
          )}
        </CountdownHead.Provider>
      )}
    </PreviewShell>
  );
}
