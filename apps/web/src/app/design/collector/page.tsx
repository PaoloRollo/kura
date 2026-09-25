import { notFound } from "next/navigation";
import { CollectorPreview } from "./preview";

const STATES = ["available", "checking", "taken", "reserved", "invalid", "named", "empty", "login", "shell"] as const;
export type CollectorPreviewState = (typeof STATES)[number];

/** Dev-only: the collector shell, login gate and Claim handle states with fixture data, for checking against the designs. */
export default async function CollectorDesignPage({ searchParams }: { searchParams: Promise<{ state?: string | string[] }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await searchParams;
  const s = (STATES as readonly string[]).includes(String(state)) ? (state as CollectorPreviewState) : "available";
  return <CollectorPreview state={s} states={STATES} />;
}
