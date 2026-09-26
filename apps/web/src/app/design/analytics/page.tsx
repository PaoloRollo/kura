import { notFound } from "next/navigation";
import { parseRange } from "@/lib/analytics-view";
import { AnalyticsPreview } from "./preview";
import { ANALYTICS_PREVIEWS, type AnalyticsPreviewState } from "./states";

const requestTime = () => Math.floor(Date.now() / 1000);

/** Dev-only: Analytics (Y1eNn, WABQw) with indexer-shaped fixtures, or `?state=live` against the live indexer. */
export default async function AnalyticsDesignPage({ searchParams }: { searchParams: Promise<{ state?: string; range?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state, range } = await searchParams;
  const s = (ANALYTICS_PREVIEWS as readonly string[]).includes(String(state)) ? (state as AnalyticsPreviewState) : "rich";
  return <AnalyticsPreview key={s} state={s} now={requestTime()} initialRange={s === "quiet-24h" && !range ? "24h" : parseRange(range)} />;
}
