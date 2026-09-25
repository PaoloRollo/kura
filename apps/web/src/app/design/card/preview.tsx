"use client";

import Link from "next/link";
import { CircleDollarSignIcon } from "lucide-react";
import { BarChip, EnsName, TopBar } from "@/components/kura";
import { CardLoading, CardNotFound, CardPageView } from "@/components/card-page-view";
import type { CardTab } from "@/lib/card-view";
import { NAV } from "@/components/site-header";
import { usePonderStatus } from "@ponder/react";
import { useCard } from "@/hooks/use-card";
import { HandlesFixture } from "@/hooks/use-handles";
import { useKuraUser } from "@/hooks/use-kura-user";
import { cn } from "@/lib/utils";
import { FIXTURE_HEAD, HANDLES, PAOLO, PREVIEW_STATES, cardFixture, type PreviewState } from "./fixtures";

/** `live`: the real page body against the live indexer for card `id`, without the /app sign-in gate. */
function LiveCard({ id, tab, now }: { id: bigint; tab: CardTab; now: number }) {
  const c = useCard(id);
  const { address } = useKuraUser();
  const block = usePonderStatus().data?.sepolia?.block?.number;
  const href = (t: CardTab) => `/design/card?state=live&id=${id}${t === "overview" ? "" : `&tab=${t}`}`;
  if (c.isLoading) return <CardLoading />;
  if (!c.card) return <CardNotFound id={id.toString()} />;
  return <CardPageView c={c} me={address} now={now} block={block != null ? BigInt(block) : null} tab={tab} tabHref={href} />;
}

export function CardPreview({ state, tab, now, liveId }: { state: PreviewState | "live"; tab: CardTab; now: number; liveId: bigint }) {
  const live = state === "live";
  const c = cardFixture(live ? "auctioning" : state, now);
  const href = (t: CardTab) => `/design/card?state=${state}${t === "overview" ? "" : `&tab=${t}`}`;
  return (
    <HandlesFixture.Provider value={live ? null : HANDLES}>
      <div className="min-h-screen">
        <TopBar
          nav={NAV.collector}
          pathname="/app"
          exactHrefs={["/app"]}
          right={
            <>
              <BarChip icon={CircleDollarSignIcon} className="hidden sm:inline-flex">248.50 USDC</BarChip>
              <span className="inline-flex h-9 items-center rounded-md border border-border px-3"><EnsName name="paolo.kura.eth" copyable={false} /></span>
            </>
          }
        />
        <nav aria-label="Preview states" data-preview-nav className="flex flex-wrap gap-2 border-b border-border px-4 py-2 lg:px-12">
          {[...PREVIEW_STATES, "live" as const].map((s) => (
            <Link key={s} href={`/design/card?state=${s}${tab === "overview" ? "" : `&tab=${tab}`}`} className={cn("rounded-full px-2.5 py-1 text-[12px]", s === state ? "bg-surface-2 text-text" : "text-muted-foreground")}>
              {s}
            </Link>
          ))}
        </nav>
        <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">
          {live ? <LiveCard id={liveId} tab={tab} now={now} />
            : state === "loading" ? <CardLoading />
            : state === "notfound" ? <CardNotFound id="999" />
            : <CardPageView c={c} me={PAOLO} now={now} block={FIXTURE_HEAD} tab={tab} tabHref={href} />}
        </main>
      </div>
    </HandlesFixture.Provider>
  );
}
