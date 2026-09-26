import { notFound } from "next/navigation";
import { REDEEM_PREVIEWS, type RedeemPreviewState } from "./states";
import { RedeemPreview } from "./preview";

/** The request time, passed down so server and client render the same ages. */
const requestTime = () => Math.floor(Date.now() / 1000);

/** Dev-only: redeem (Ps4OJ, M3M7L5), payouts (UwCiy) and sending shards (lkEjP) with fixtures and a fake chain; nothing is sent. */
export default async function RedeemDesignPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await searchParams;
  const s = (REDEEM_PREVIEWS as readonly string[]).includes(String(state)) ? (state as RedeemPreviewState) : REDEEM_PREVIEWS[0];
  return <RedeemPreview state={s} now={requestTime()} />;
}
