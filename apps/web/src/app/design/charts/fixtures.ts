// Dev-only chart fixtures, shaped like the values the analytics screens show (LqnA2, Y1eNn). Fixed times so server and
// client render the same labels.
import type { DailyPoint } from "@/components/charts/daily-bars";
import type { DemandLevel } from "@/components/charts/demand-bars";
import type { HolderPoint } from "@/components/charts/holder-bars";
import type { LeaderboardRow } from "@/components/charts/leaderboard";
import type { TreemapItem } from "@/components/charts/market-treemap";
import type { PricePoint } from "@/components/charts/price-bars";
import type { ShareRow } from "@/components/charts/share-bars";

/** 2026-09-24 14:02 UTC: the auction opens. */
export const SHARDED_AT = 1_790_258_520;
const MIN = 60;
export const SETTLED_AT = SHARDED_AT + 20 * MIN;
export const MARKET = 1562.5;

const CLIMB = [1560, 1560, 1572, 1584, 1604, 1616, 1626, 1646, 1655, 1666, 1686, 1697, 1705, 1712];
/** Fourteen samples up to the settle, then six flat at the final clearing. */
export const PRICES: PricePoint[] = [
  ...CLIMB.map((clearing, i) => ({ t: SHARDED_AT + Math.round((i * 20 * MIN) / (CLIMB.length - 1)), clearing })),
  ...Array.from({ length: 6 }, (_, i) => ({ t: SETTLED_AT + (i + 1) * 4 * MIN, clearing: 1712 })),
];

export const DEMAND: DemandLevel[] = [
  { price: 1800, cumulative: 1800 },
  { price: 1760, cumulative: 3560 },
  { price: 1712, cumulative: 6848 },
  { price: 1700, cumulative: 8500 },
  { price: 1640, cumulative: 9320 },
  { price: 1580, cumulative: 10500 },
];

export const HOLDERS: HolderPoint[] = [1, 1, 1, 2, 3, 3, 4, 4, 4, 4].map((holders, i) => ({ t: SHARDED_AT + i * 3 * MIN, holders }));

export const OWNERSHIP = [
  { id: "paolo", name: "paolo.kura.eth", value: 81.3 },
  { id: "kenji", name: "kenji.kura.eth", value: 9.4 },
  { id: "x7a3", name: "0x7a3…91c2", value: 6.3 },
  { id: "aiko", name: "aiko.kura.eth", value: 3.0 },
];

const card = (id: number, tab = "analytics") => `/app/cards/${id}?tab=${tab}`;
export const TREEMAP: TreemapItem[] = [
  { id: "1", name: "Black Lotus", value: 27392, premium: 0.096, href: card(1), thumb: "/cards/black-lotus.webp", ensName: "black-lotus-lea-1.kura.eth" },
  { id: "2", name: "Mox Sapphire", value: 19968, premium: 0, href: card(2), thumb: "/cards/mox-sapphire.webp" },
  { id: "3", name: "Jace, the Mind Sculptor", value: 11200, premium: -0.185, href: card(3), thumb: "/cards/jace-the-mind-sculptor.webp" },
  { id: "4", name: "Time Walk", value: 9440, premium: 0.148, href: card(4), thumb: "/cards/time-walk.webp" },
  { id: "5", name: "Ancestral Recall", value: 8200, premium: -0.072, href: card(5), thumb: "/cards/ancestral-recall.webp" },
  { id: "6", name: "Force of Will", value: 5640, premium: 0.031, href: card(6), thumb: "/cards/force-of-will.webp" },
  { id: "7", name: "Sol Ring", value: 3412, premium: 0.224, href: card(7), thumb: "/cards/sol-ring.webp" },
  { id: "8", name: "Lightning Bolt · JA", value: 2096, premium: -0.03, href: card(8) },
  { id: "9", name: "Wheel of Fortune", value: 1400, premium: null, href: card(9) },
];

export const DAILY: DailyPoint[] = [4200, 11800, 7100, 15400, 9600, 21300, 27000].map((value, i) => ({
  date: `2026-09-${String(18 + i).padStart(2, "0")}`,
  value,
}));

export const PREMIUMS: LeaderboardRow[] = [
  { rank: 1, label: "Time Walk", value: "+14.8%", tone: "pos", thumb: "/cards/time-walk.webp", href: card(4) },
  { rank: 2, label: "Black Lotus", value: "+9.6%", tone: "pos", thumb: "/cards/black-lotus.webp", href: card(1) },
  { rank: 3, label: "Force of Will", value: "+3.1%", tone: "pos", thumb: "/cards/force-of-will.webp", href: card(6) },
  { rank: 4, label: "Jace, the Mind Sculptor", value: "-18.5%", tone: "neg", thumb: "/cards/jace-the-mind-sculptor.webp", href: card(3) },
];

export const LANGUAGES: ShareRow[] = [
  { label: "English", count: 15 },
  { label: "Japanese", count: 5 },
  { label: "German", count: 2 },
  { label: "Italian", count: 1 },
];
