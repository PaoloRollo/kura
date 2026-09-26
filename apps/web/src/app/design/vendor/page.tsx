import { notFound } from "next/navigation";
import { VendorPreview } from "./preview";

const VIEWS = [
  "inventory", "inventory-fixture", "inventory-empty", "handover",
  "handover-waiting", "handover-verified", "handover-expired", "handover-released",
  "fees", "fees-fixture", "fees-empty",
] as const;
export type PreviewView = (typeof VIEWS)[number];

/**
 * Dev-only: the vendor inventory and fees screens without the vendor sign-in gate. `inventory`, `handover` and `fees`
 * read the live indexer and vault; the `-fixture` and `-empty` views use fixture data, for checking against the designs.
 * `handover-<stage>` opens the hand-over panel (tM3Hy, ykB2t) on a fixture row in each stage; nothing is sent.
 */
export default async function VendorDesignPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { view } = await searchParams;
  const v = (VIEWS as readonly string[]).includes(String(view)) ? (view as PreviewView) : "inventory";
  return <VendorPreview view={v} views={VIEWS} />;
}
