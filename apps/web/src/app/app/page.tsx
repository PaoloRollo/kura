"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ExploreView } from "@/components/explore-view";
import { IndexerLoading } from "@/components/sync-state";
import { useExploreData } from "@/hooks/use-explore";
import { useNow } from "@/hooks/use-now";
import { filtersToQuery, parseFilters, type ExploreFilters } from "@/lib/explore";

function Explore() {
  const params = useSearchParams();
  const [filters, setFilters] = useState<ExploreFilters>(() => parseFilters(params));
  // A navigation that changes the query (the Explore tab while filtered, back/forward) resets the filters to it. Our own
  // replaceState writes exactly filtersToQuery(filters), so it never triggers this.
  const query = params.toString();
  const [seen, setSeen] = useState(query);
  if (query !== seen) {
    setSeen(query);
    if (query !== filtersToQuery(filters)) setFilters(parseFilters(params));
  }
  const data = useExploreData(filters.tab);
  const now = useNow(30_000);

  // The query mirrors the filters without a navigation (a shared link reopens the same view).
  useEffect(() => {
    const q = filtersToQuery(filters);
    const next = `${window.location.pathname}${q ? `?${q}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next);
  }, [filters]);

  return <ExploreView {...data} filters={filters} onFilters={setFilters} now={now} />;
}

/** Explore: live auctions with search, filters and sort kept in the URL query, and what's new in the vault. */
export default function ExplorePage() {
  // useSearchParams needs a Suspense boundary so the page can still prerender.
  return (
    <Suspense fallback={<IndexerLoading title="Loading auctions" className="max-w-md" />}>
      <Explore />
    </Suspense>
  );
}
