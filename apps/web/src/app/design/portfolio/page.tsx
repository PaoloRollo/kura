import { notFound } from "next/navigation";
import { PORTFOLIO_PREVIEWS, type PortfolioPreviewState } from "./states";
import { PortfolioPreview } from "./preview";

const requestTime = () => Math.floor(Date.now() / 1000);

/** Dev-only: Portfolio (QEEV7, YH4Ft, BJyHN, K7qgeI) and My shards (sWbGq, e2yS2e) with fixtures; nothing is sent. */
export default async function PortfolioDesignPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await searchParams;
  const s = (PORTFOLIO_PREVIEWS as readonly string[]).includes(String(state)) ? (state as PortfolioPreviewState) : PORTFOLIO_PREVIEWS[0];
  return <PortfolioPreview key={s} state={s} now={requestTime()} />;
}
