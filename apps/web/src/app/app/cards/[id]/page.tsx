"use client";

import { use } from "react";
import { useSearchParams } from "next/navigation";
import { usePonderStatus } from "@ponder/react";
import { CardPageView } from "@/components/card-page-view";
import { CardLoading, CardNotFound } from "@/components/card-page-parts";
import { parseTab, type CardTab } from "@/lib/card-view";
import { useCard } from "@/hooks/use-card";
import { useKuraUser } from "@/hooks/use-kura-user";
import { useNow } from "@/hooks/use-now";

/** A vault card, addressed by id (the vault's siteURI + id). Tabs are linkable through `?tab=`. */
export default function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const valid = /^\d+$/.test(id);
  const c = useCard(valid ? BigInt(id) : 0n);
  const { address } = useKuraUser();
  const now = useNow(30_000);
  const status = usePonderStatus();
  const block = status.data?.sepolia?.block?.number;
  const tab = parseTab(useSearchParams().get("tab"));
  const tabHref = (t: CardTab) => (t === "overview" ? `/app/cards/${id}` : `/app/cards/${id}?tab=${t}`);

  if (!valid) return <CardNotFound id={id} />;
  if (c.isLoading) return <CardLoading />;
  if (!c.card) return <CardNotFound id={id} />;
  return <CardPageView c={c} me={address} now={now} block={block != null ? BigInt(block) : null} tab={tab} tabHref={tabHref} />;
}
