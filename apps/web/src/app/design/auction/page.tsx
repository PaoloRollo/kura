import { notFound } from "next/navigation";
import { parseTab } from "@/lib/card-view";
import { AUCTION_PREVIEWS, type AuctionPreviewState } from "./states";
import { AuctionPreview } from "./preview";

/** The request time, passed down so server and client render the same ages. */
const requestTime = () => Math.floor(Date.now() / 1000);

/** Dev-only: the auction panel (HisVE, aD9is, p5hrR, g5bcZ) with indexer-shaped fixtures and a fake chain; nothing is sent. */
export default async function AuctionDesignPage({ searchParams }: { searchParams: Promise<{ state?: string; tab?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state, tab } = await searchParams;
  const s = (AUCTION_PREVIEWS as readonly string[]).includes(String(state)) ? (state as AuctionPreviewState) : AUCTION_PREVIEWS[0];
  return <AuctionPreview state={s} tab={parseTab(tab)} now={requestTime()} />;
}
