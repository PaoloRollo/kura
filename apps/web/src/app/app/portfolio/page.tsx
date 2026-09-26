"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PORTFOLIO_TABS, PortfolioView, type PortfolioTab } from "@/components/portfolio-view";
import { IndexerLoading } from "@/components/sync-state";
import { PayoutClaimedView, showVaultSuccess, useVaultSuccess } from "@/components/vault-success";
import { useKuraUser } from "@/hooks/use-kura-user";
import { usePortfolio } from "@/hooks/use-portfolio";

const parseTab = (v: string | null): PortfolioTab => (PORTFOLIO_TABS as readonly string[]).includes(v ?? "") ? (v as PortfolioTab) : "shards";

function Portfolio({ me }: { me: `0x${string}` }) {
  const params = useSearchParams();
  const [tab, setTab] = useState<PortfolioTab>(() => parseTab(params.get("tab")));
  const d = usePortfolio(me);
  const success = useVaultSuccess();

  useEffect(() => {
    const next = `${window.location.pathname}${tab === "shards" ? "" : `?tab=${tab}`}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next);
  }, [tab]);
  useEffect(() => () => showVaultSuccess(null), []);

  // A payout claimed from the banner ends on UwCiy; the portfolio is one tap away.
  if (success?.kind === "claimed") {
    const name = d.payouts.find((p) => p.sharding.cardId === success.cardId)?.name ?? d.holdings.find((h) => h.cardId === success.cardId)?.name ?? `card #${success.cardId}`;
    return <PayoutClaimedView info={success} cardName={name} onClose={() => showVaultSuccess(null)} />;
  }
  return <PortfolioView d={d} tab={tab} onTab={setTab} />;
}

/** Collector · Portfolio: shards with cost basis, whole cards, bids, payouts and the wallet. */
export default function PortfolioPage() {
  const { address } = useKuraUser();
  const loading = <IndexerLoading title="Loading your portfolio" className="max-w-md" />;
  if (!address) return loading;
  return (
    <Suspense fallback={loading}>
      <Portfolio me={address} />
    </Suspense>
  );
}
