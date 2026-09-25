import { notFound } from "next/navigation";
import { parseTab } from "@/lib/card-view";
import { PREVIEW_STATES, type PreviewState } from "./fixtures";
import { CardPreview } from "./preview";

/** The request time: fixtures are placed relative to it, and it is passed down so server and client render the same ages. */
const requestTime = () => Math.floor(Date.now() / 1000);

/** Dev-only: the card page in every state with indexer-shaped fixtures (no card has been sharded on Sepolia yet), or `?state=live&id=` against the live indexer. */
export default async function CardDesignPage({ searchParams }: { searchParams: Promise<{ state?: string; tab?: string; id?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state, tab, id } = await searchParams;
  const s = state === "live" ? "live" : (PREVIEW_STATES as readonly string[]).includes(String(state)) ? (state as PreviewState) : "auctioning";
  return <CardPreview state={s} tab={parseTab(tab)} now={requestTime()} liveId={BigInt(/^\d+$/.test(id ?? "") ? id! : "1")} />;
}
