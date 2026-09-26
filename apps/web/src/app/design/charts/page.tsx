import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EnsName } from "@/components/kura";
import { DailyBars } from "@/components/charts/daily-bars";
import { DemandBars } from "@/components/charts/demand-bars";
import { HolderBars } from "@/components/charts/holder-bars";
import { KpiStrip } from "@/components/charts/kpi-strip";
import { Leaderboard } from "@/components/charts/leaderboard";
import { MarketTreemap } from "@/components/charts/market-treemap";
import { OwnershipBar } from "@/components/charts/ownership-bar";
import { PriceBars } from "@/components/charts/price-bars";
import { ShareBars } from "@/components/charts/share-bars";
import {
  DAILY,
  DEMAND,
  HOLDERS,
  LANGUAGES,
  MARKET,
  OWNERSHIP,
  PRICES,
  PREMIUMS,
  SETTLED_AT,
  SHARDED_AT,
  TREEMAP,
} from "./fixtures";

export const metadata: Metadata = { title: "Kura · Charts" };

function Group({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-[11px] tracking-[1px] text-muted-foreground uppercase">
        {title} <span className="font-mono normal-case">· {id}</span>
      </h2>
      {children}
    </section>
  );
}

/** Dev-only: every chart primitive with fixture data, laid out as the Card analytics (LqnA2) and Analytics (Y1eNn) screens. */
export default function ChartsDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-12 px-4 py-12 sm:px-12">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[36px] font-semibold text-text">Charts</h1>
        <p className="text-[13px] text-text-2">
          Chart primitives with fixtures. Every panel has a Table view. Narrow the window below 640px for the phone layout (WABQw).
        </p>
      </header>

      <Group id="LqnA2" title="Card analytics">
        <KpiStrip
          items={[
            { label: "Implied value", value: "$27,392", sub: "clearing × 16" },
            { label: "Premium", value: "+9.6%", sub: "vs Scryfall $25,000", tone: "pos" },
            { label: "Concentration", value: "0.67", sub: "HHI, 1.0 = one owner" },
            { label: "To redemption", value: "eligible", sub: "top holder 81.3%", tone: "kin" },
            { label: "Fill rate", value: "100%", sub: "3 of 3 shards sold" },
            { label: "Bidders", value: "7", sub: "unique humans" },
          ]}
        />
        <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr] lg:items-start">
          <PriceBars points={PRICES} settledAt={SETTLED_AT} marks={[{ t: SETTLED_AT, label: "S" }]} market={MARKET} />
          <DemandBars points={DEMAND} clearing={1712} forSale={3} />
        </div>
        <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr] lg:items-start">
          <HolderBars points={HOLDERS} shardedAt={SHARDED_AT} settledAt={SETTLED_AT} />
          <OwnershipBar slices={OWNERSHIP.map((o) => ({ ...o, label: <EnsName name={o.name} copyable={false} avatar={false} /> }))} />
        </div>
        <PriceBars
          points={PRICES.slice(0, 12)}
          marks={[{ t: PRICES[3]!.t, label: "A" }, { t: PRICES[11]!.t, label: "S" }, { t: PRICES[11]!.t + 30, label: "B" }]}
          market={1600}
          footer="Appraisal marked; a settle and a buyout on the same sample share one chip (S·B)"
        />
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <DemandBars points={[]} clearing={null} />
          <OwnershipBar slices={[...OWNERSHIP, { id: "e", name: "ren.kura.eth", value: 0.9 }, { id: "f", name: "0x19c…04ab", value: 0.4 }].map((o) => ({ ...o, label: o.name }))} subtitle="Six holders: the top four, then Other" />
        </div>
      </Group>

      <Group id="Y1eNn" title="Analytics">
        <KpiStrip
          items={[
            { label: "Cards in vault", value: "23", sub: "+4 this week", hideOnMobile: true },
            { label: "Value locked", value: "$412,860", sub: "implied at clearing" },
            { label: "Raised", value: "$96,420", sub: "across 11 auctions" },
            { label: "Fees to vault", value: "$2,410", sub: "2.5% of sales + buyouts" },
            { label: "Live auctions", value: "3", sub: "next ends in 04:12", hideOnMobile: true },
            { label: "Verified collectors", value: "58", sub: "World ID, one per human" },
          ]}
        />
        <MarketTreemap items={TREEMAP} />
        <div className="grid gap-4 lg:grid-cols-[1.45fr_1fr_0.7fr] lg:items-start">
          <DailyBars points={DAILY} label="Volume, USDC" />
          <Leaderboard title="Richest premiums" subtitle="Clearing price vs market" valueLabel="Premium" rows={PREMIUMS} />
          <ShareBars rows={LANGUAGES} />
        </div>
      </Group>
    </main>
  );
}
