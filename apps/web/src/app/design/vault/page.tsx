import { notFound } from "next/navigation";
import { VaultPreview } from "./preview";

const STATES = ["released", "no-releases", "loading"] as const;
const requestTime = () => Math.floor(Date.now() / 1000);

/** Dev-only: Collector · Vault (Pu0g5) with fixture stats and releases. */
export default async function VaultDesignPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await searchParams;
  const s = (STATES as readonly string[]).includes(String(state)) ? String(state) : STATES[0];
  return <VaultPreview key={s} state={s} states={STATES} now={requestTime()} />;
}
