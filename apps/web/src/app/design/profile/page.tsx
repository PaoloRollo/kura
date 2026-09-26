import { notFound } from "next/navigation";
import { ProfilePreview } from "./preview";

const STATES = ["verified", "no-usdc", "no-handle", "external"] as const;

/** Dev-only: Mobile · Profile (xog3h) with fixture wallets. */
export default async function ProfileDesignPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await searchParams;
  const s = (STATES as readonly string[]).includes(String(state)) ? String(state) : STATES[0];
  return <ProfilePreview key={s} state={s} states={STATES} />;
}
