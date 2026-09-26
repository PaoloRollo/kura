"use client";

import type * as React from "react";

import Link from "next/link";
import dynamic from "next/dynamic";
import { ActivityFeed, ActivityList } from "@/components/activity-feed";
import { CardArtColumn, CardHeader, CompactHeader, Credit, ShardedBy } from "@/components/card-header";
import { AuctionPanel, hasBidActions } from "@/components/auction-panel";
import { CardAnalyticsLoading } from "@/components/card-analytics-loading";
import { identityOf } from "@/components/card-page-parts";
import { OwnerSettled, showOwnerSettled, useOwnerSettled, type SettledInfo } from "@/components/settle-success";
import { OwnedByPanel, OwnerPanel, PastAuction, ReleasedSummary, ShardedSummary } from "@/components/card-state-panel";
import { EnsRecords } from "@/components/ens-records";
import { MarketPanel } from "@/components/market-panel";
import { PayoutPanel } from "@/components/payout-panel";
import { RedeemPanel } from "@/components/redeem-panel";
import { PayoutClaimedView, RedeemedView, showVaultSuccess, useVaultSuccess } from "@/components/vault-success";
import { MobileNav } from "@/components/mobile-nav";
import { HoldersList, OwnershipSummary } from "@/components/holders-list";
import { ACTIVITY_LIMIT, type CardData } from "@/hooks/use-card";
import type { MarketPoint } from "@/app/api/cards/[id]/market/route";
import { addresses } from "@/lib/chain";
import { buildFeed } from "@/lib/activity-feed";
import { CARD_TABS, agoLong, dateTime, holdersView, lastBuyout, type CardTab } from "@/lib/card-view";
import { cn } from "@/lib/utils";

// The Analytics tab's charts (recharts) load only when the tab opens, not with every card page.
const CardAnalytics = dynamic(() => import("@/components/card-analytics").then((m) => m.CardAnalytics), { ssr: false, loading: () => <CardAnalyticsLoading /> });

/** The tab strip, linkable through `?tab=`, with a shu underline on the active tab. */
export function CardTabs({ tab, href }: { tab: CardTab; href: (t: CardTab) => string }) {
  return (
    <nav aria-label="Card sections" className="flex gap-8 overflow-x-auto border-b border-border">
      {CARD_TABS.map((t) => (
        <Link
          key={t.value}
          href={href(t.value)}
          scroll={false}
          aria-current={t.value === tab ? "page" : undefined}
          className={cn(
            "-mb-px shrink-0 border-b-2 pb-3 text-[14px] transition-colors",
            t.value === tab ? "border-shu font-semibold text-text" : "border-transparent text-text-2 hover:text-text",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export type CardPageViewProps = {
  c: CardData;
  /** The viewer's wallet, or null. */
  me: string | null;
  /** Unix seconds, for ages. */
  now: number;
  /** The indexer's latest block, for the auction countdown. */
  block: bigint | null;
  tab: CardTab;
  tabHref: (t: CardTab) => string;
  /** The Analytics tab's market series, overriding its /api/cards/[id]/market fetch (the /design previews' fixtures). */
  market?: MarketPoint[];
};

/** The card page (HisVE, Ps4OJ, oezcX, gmKpU, mWV0E, yV8eD) for a loaded card. */
export function CardPageView({ c, me, now, block, tab, tabHref, market }: CardPageViewProps) {
  const card = c.card!;
  const identity = identityOf(c);
  const settledInfo = useOwnerSettled(card.id);
  const vaultSuccess = useVaultSuccess(card.id);
  if (settledInfo) {
    return (
      <div className="flex flex-col gap-4">
        <MobileNav title={identity.name} className="-mt-2" />
        <OwnerSettled info={settledInfo} cardName={identity.name} {...settledCounts(c, settledInfo)} onClose={() => showOwnerSettled(null)} />
      </div>
    );
  }
  if (vaultSuccess) {
    return (
      <div className="flex flex-col gap-4">
        <MobileNav title={identity.name} className="-mt-2" />
        {vaultSuccess.kind === "redeemed"
          ? <RedeemedView info={vaultSuccess} cardName={identity.name} onClose={() => showVaultSuccess(null)} />
          : <PayoutClaimedView info={vaultSuccess} cardName={identity.name} onClose={() => showVaultSuccess(null)} />}
      </div>
    );
  }
  const holders = holdersView({ balances: c.holders, sharding: c.sharding, shardings: c.allShardings, transfers: c.transfers, vault: addresses.cardVault, bids: c.bids });
  const released = card.state === "released";
  const isOwner = card.state === "whole" && !!me && card.ownerOf.toLowerCase() === me.toLowerCase();
  const shards = c.sharding && card.state !== "whole" ? c.sharding.totalShards : null;
  const revoked = released || !!c.ensName?.revokedAt;
  const buyout = lastBuyout(card, c.allShardings, c.activities);
  const settleOf = (token: string) => c.activities.find((a) => a.kind === "settle" && (a.meta as { shardToken?: string } | null)?.shardToken?.toLowerCase() === token.toLowerCase());
  const feed = buildFeed({ activities: c.activities, transfers: c.transfers, records: c.ensRecords, ctx: { shardings: c.allShardings, ensName: card.ensName, parties: addresses } });

  if (tab !== "overview") {
    return (
      <div className="flex flex-col gap-7">
        <MobileNav title={identity.name} className="-mt-2 -mb-3" />
        <CompactHeader card={card} identity={identity} shards={shards} sharding={c.sharding} block={block} />
        <CardTabs tab={tab} href={tabHref} />
        {tab === "holders" && (
          <HoldersList
            view={holders}
            now={now}
            whole={card.state === "whole" || !c.sharding}
            buyout={buyout ? { at: buyout.redeem ? dateTime(buyout.redeem.timestamp) : null, href: tabHref("activity") } : null}
          />
        )}
        {tab === "activity" && <ActivityFeed rows={feed} now={now} capped={c.activities.length >= ACTIVITY_LIMIT} />}
        {tab === "auction" && (
          c.sharding ? (
            <AuctionPanel c={c} me={me as `0x${string}` | null} block={block} />
          ) : c.allShardings[0] ? (
            <PastAuction s={c.allShardings[0]} settledAt={(() => { const st = settleOf(c.allShardings[0].shardToken); return st ? dateTime(st.timestamp) : null; })()} />
          ) : (
            <Empty title="No auction yet" body="This card is whole. An auction starts when its owner shards it." />
          )
        )}
        {tab === "analytics" && <CardAnalytics data={c} now={now} market={market} />}
      </div>
    );
  }

  const shardActivity = c.activities.find((a) => a.kind === "shard");
  const settled = c.activities.find((a) => a.kind === "settle");
  const context =
    card.state === "auctioning" ? <ShardedBy address={shardActivity?.actor ?? card.beneficialOwner} />
    : card.state === "sharded" ? (settled ? `auction settled ${agoLong(settled.timestamp, now)}` : "auction settled")
    : released ? "name revoked on release"
    : null;

  const panel =
    card.state === "whole" ? (isOwner ? <OwnerPanel c={c} name={identity.name} /> : <OwnedByPanel c={c} />)
    : card.state === "auctioning" && c.sharding ? <AuctionPanel c={c} me={me as `0x${string}` | null} block={block} />
    : card.state === "sharded" && c.sharding ? (hasBidActions(c, me, null) ? <AuctionPanel c={c} me={me as `0x${string}` | null} block={block} />
      : me ? <RedeemPanel c={c} me={me as `0x${string}`} fallback={<ShardedSummary c={c} />} />
      : <ShardedSummary c={c} />)
    : released ? <ReleasedSummary c={c} />
    : null;

  return (
    <div className="flex flex-col gap-8">
      {/* yV8eD: the Nav row has no title on the Overview; the name sits under the art. */}
      <MobileNav className="-mt-2 -mb-4" />
      <CardTabs tab={tab} href={tabHref} />
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[420px_minmax(0,1fr)]">
        <CardArtColumn identity={identity} condition={card.condition} released={released}>
          <EnsRecords records={c.ensRecords} revoked={revoked} className="max-lg:hidden" />
        </CardArtColumn>
        <div className="flex min-w-0 flex-col gap-8">
          <div className="flex flex-col gap-2">
            <CardHeader card={card} identity={identity} context={context} sharding={c.sharding} block={block} />
            {/* Mobile (yV8eD): the credit line sits under the ENS name; on desktop it is under the art. */}
            <Credit identity={identity} className="lg:hidden" />
          </div>
          {panel}
          {/* The card's Uniswap pool: trading while sharded, "closed" after a buyout; nothing without a pool. */}
          {!released && <MarketPanel c={c} me={me as `0x${string}` | null} />}
          {/* Payouts of bought-out shardings stay claimable, released cards included (each renders only with a balance). */}
          {c.allShardings.filter((s) => s.redeemer && s.buyoutPerShard != null).map((s) => (
            <PayoutPanel key={s.shardToken} me={me as `0x${string}` | null} cardName={identity.name} sharding={{ cardId: s.cardId, shardToken: s.shardToken, buyoutPerShard: s.buyoutPerShard!, redeemer: s.redeemer }} />
          ))}
          {!released && (
            <div className="grid gap-10 xl:grid-cols-2">
              <OwnershipSummary view={holders} owner={card.state === "whole" ? card.ownerOf : null} />
              <section className="flex min-w-0 flex-col gap-4">
                <h2 className="font-display text-[24px] font-semibold text-text">Activity</h2>
                <ActivityList rows={feed} now={now} />
              </section>
            </div>
          )}
          <EnsRecords records={c.ensRecords} revoked={revoked} className="lg:hidden" />
        </div>
      </div>
    </div>
  );
}

/** Shards sold (`totalCleared()`, read after settle) and distinct buyers of the settled auction, for the Oh2m9 sentence. */
function settledCounts(c: CardData, info: SettledInfo): { sold: number | null; buyers: number } {
  const sold = info.graduated ? info.sold : null;
  const auction = c.sharding?.auction.toLowerCase();
  const filled = c.bids.filter((b) => b.auction.toLowerCase() === auction && (b.tokensFilled != null ? b.tokensFilled > 0n : b.maxPriceQ96 >= info.clearingQ96));
  return { sold, buyers: new Set(filled.map((b) => b.owner.toLowerCase())).size };
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-6">
      <h3 className="text-[16px] font-semibold text-text">{title}</h3>
      <p className="mt-1 text-[13px] text-text-2">{body}</p>
    </div>
  );
}
