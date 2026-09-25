import { notFound } from "next/navigation";
import { StationPreview } from "./preview";

const STATES = ["empty", "details", "search", "minted", "signin", "denied"] as const;
export type PreviewState = (typeof STATES)[number];

/** Dev-only: the vendor station and its shell states with fixture data, for checking against the designs. */
export default async function StationDesignPage({ searchParams }: { searchParams: Promise<{ state?: string | string[] }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await searchParams;
  const s = (STATES as readonly string[]).includes(String(state)) ? (state as PreviewState) : "empty";
  return <StationPreview state={s} states={STATES} />;
}
