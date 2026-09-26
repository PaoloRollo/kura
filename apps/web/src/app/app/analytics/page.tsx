import Link from "next/link";
import { ChartColumnIcon, CompassIcon, WalletIcon } from "lucide-react";
import { Button } from "@/components/kura";
import { MobilePageTitle } from "@/components/page-title";

/** Collector · Analytics: a placeholder until the analytics dashboard (plan 5) lands. */
export default function AnalyticsPage() {
  return (
    <div className="flex flex-col gap-5">
      <MobilePageTitle title="Analytics" />
      <section className="flex max-w-md flex-col items-start gap-3 rounded-2xl border border-border bg-surface p-5">
        <span className="rounded-md bg-surface-2 px-2 py-1 text-[10px] font-semibold tracking-[1px] text-text-2 uppercase">Coming soon</span>
        <span className="flex size-11 items-center justify-center rounded-lg bg-kin-soft text-kin [&_svg]:size-5"><ChartColumnIcon aria-hidden /></span>
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-[22px] leading-tight font-semibold text-text">Vault analytics are on their way</h1>
          <p className="text-[13px] text-text-2">
            Price history, clearing prices and holder trends for every card in the vault. Until then, live auctions are on
            Explore and your shards and bids are in your portfolio.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="primary" size="compact"><Link href="/app"><CompassIcon aria-hidden />Explore auctions</Link></Button>
          <Button asChild variant="secondary" size="compact"><Link href="/app/portfolio"><WalletIcon aria-hidden />Your portfolio</Link></Button>
        </div>
      </section>
    </div>
  );
}
