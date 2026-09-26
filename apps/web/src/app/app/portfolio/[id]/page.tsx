"use client";

import { use } from "react";
import { CardLoading, CardNotFound } from "@/components/card-page-view";
import { MyShardsView } from "@/components/my-shards-view";
import { useCard } from "@/hooks/use-card";
import { useKuraUser } from "@/hooks/use-kura-user";
import { useNow } from "@/hooks/use-now";
import { useWorldIdVerified } from "@/hooks/use-portfolio";
import { useVaultFeeBps } from "@/hooks/use-vault-fee";

/** My shards (sWbGq, e2yS2e): my position in one card, from the portfolio. */
export default function MyShardsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const valid = /^\d+$/.test(id);
  const c = useCard(valid ? BigInt(id) : 0n);
  const { address } = useKuraUser();
  const { binding } = useWorldIdVerified(address);
  const feeBps = useVaultFeeBps();
  const now = useNow(30_000);

  if (!valid) return <CardNotFound id={id} />;
  if (c.isLoading || !address) return <CardLoading />;
  if (!c.card) return <CardNotFound id={id} />;
  return <MyShardsView c={c} me={address} now={now} binding={binding} feeBps={feeBps} />;
}
