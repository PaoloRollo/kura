import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ShardPreview } from "./preview";
import { SHARD_PREVIEWS, type ShardPreviewState } from "./states";

/** The request time, passed down so server and client render the same end dates. */
const requestTime = () => Math.floor(Date.now() / 1000);

/** Dev-only: the sharding wizard (bWyqz, ITGkz, couMI) and its end states with fixtures, or `?state=live&id=` against the live indexer. */
export default async function ShardDesignPage({ searchParams }: { searchParams: Promise<{ state?: string; id?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state, id } = await searchParams;
  const s = (SHARD_PREVIEWS as readonly string[]).includes(String(state)) ? (state as ShardPreviewState) : "step1";
  return <Suspense><ShardPreview state={s} now={requestTime()} liveId={BigInt(/^\d+$/.test(id ?? "") ? id! : "1")} /></Suspense>;
}
