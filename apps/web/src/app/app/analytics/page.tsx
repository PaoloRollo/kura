"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AnalyticsDashboard } from "@/components/analytics-dashboard";
import { IndexerLoading } from "@/components/sync-state";
import { useAnalytics } from "@/hooks/use-analytics";
import { DEFAULT_RANGE, parseRange, type AnalyticsRange } from "@/lib/analytics-view";

function Analytics() {
  const params = useSearchParams();
  const [range, setRange] = useState<AnalyticsRange>(() => parseRange(params.get("range")));
  const data = useAnalytics(range);
  const onRange = (r: AnalyticsRange) => {
    setRange(r);
    // The range lives in ?range= (7d, the default, is left out) without a navigation.
    const next = `${window.location.pathname}${r === DEFAULT_RANGE ? "" : `?range=${r}`}`;
    window.history.replaceState(null, "", next);
  };
  return <AnalyticsDashboard {...data} range={range} onRange={onRange} />;
}

/** Collector · Analytics: the vault-wide dashboard, live from the indexer. */
export default function AnalyticsPage() {
  // useSearchParams needs a Suspense boundary so the page can still prerender.
  return (
    <Suspense fallback={<IndexerLoading title="Loading the vault's analytics" className="max-w-md" />}>
      <Analytics />
    </Suspense>
  );
}
