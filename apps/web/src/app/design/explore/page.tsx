import { notFound } from "next/navigation";
import { EXPLORE_PREVIEWS, type ExplorePreviewState } from "./states";
import { ExplorePreview } from "./preview";

const requestTime = () => Math.floor(Date.now() / 1000);

/** Dev-only: Explore (TQ4jp, Z6BlV0, aUlMV, NWOiJ) with fixture auctions. */
export default async function ExploreDesignPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await searchParams;
  const s = (EXPLORE_PREVIEWS as readonly string[]).includes(String(state)) ? (state as ExplorePreviewState) : EXPLORE_PREVIEWS[0];
  return <ExplorePreview key={s} state={s} now={requestTime()} />;
}
