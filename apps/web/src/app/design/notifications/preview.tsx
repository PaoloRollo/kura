"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCheckIcon, CircleDollarSignIcon, GavelIcon, HandCoinsIcon } from "lucide-react";
import { usdcPerShardToQ96 } from "@kura/shared";
import { BarChip, Button, EnsName, KuraToast, TopBar, notify } from "@/components/kura";
import { NotificationsMenu } from "@/components/notifications-panel";
import { NAV } from "@/components/site-header";
import { liveToast, type LiveContext, type LiveEvent, type LiveToast } from "@/lib/live-events";
import { deriveNotifications, isUnread, type NotificationInput } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { addr, hash, HEAD, S, usd } from "../catalog";
import { AIKO, KENJI, PAOLO } from "../card/fixtures";
import { NOTIFICATION_PREVIEWS, type NotificationPreviewState } from "./states";

const q = (d: number) => usdcPerShardToQ96(usd(d));
const NAMES: Record<number, string> = { 1: "Black Lotus", 2: "Time Walk", 3: "Ancestral Recall", 4: "Mox Sapphire", 5: "Force of Will", 6: "Jace, the Mind Sculptor" };
const name = (a: string) => (a === KENJI ? "kenji.kura.eth" : a === AIKO ? "aiko.kura.eth" : a === PAOLO ? "paolo.kura.eth" : a);
const VAULT = addr(0x9);

type Sharding = NotificationInput["shardings"][number];
const sharding = (n: number, over: Partial<Sharding> = {}): Sharding => ({
  shardToken: addr(0x100 + n), cardId: BigInt(n), auction: addr(0x200 + n), totalShards: 16, floorPriceQ96: q(1000), endBlock: HEAD + 50_000n, settled: true,
  graduated: true, clearingUsdcPerShard: null, raisedUsdc: null, feeUsdc: null, buyoutPerShard: null, redeemer: null, updatedAt: 0, ...over,
});

/** Indexer-shaped rows for paolo: one of each of the six notification kinds (RWhQ9's list). */
function fixture(now: number): NotificationInput {
  const lotus = sharding(1, { settled: false, graduated: null });
  const walk = sharding(2, { redeemer: AIKO, buyoutPerShard: usd(1840), updatedAt: now - 840 });
  const recall = sharding(3, { settled: false, graduated: null, endBlock: HEAD + 50n });
  const mox = sharding(4, { clearingUsdcPerShard: usd(1712), raisedUsdc: usd(5136), feeUsdc: usd(128.4) });
  const force = sharding(5, { totalShards: 32 });
  const jace = sharding(6);
  const bal = (s: Sharding, units: bigint, ago: number) => ({ shardToken: s.shardToken, holder: PAOLO, balance: units, updatedAt: now - ago });
  return {
    me: PAOLO, block: HEAD, now, vault: VAULT,
    cards: [
      { id: 5n, state: "sharded", shardToken: force.shardToken },
      { id: 6n, state: "sharded", shardToken: jace.shardToken },
    ],
    shardings: [lotus, walk, recall, mox, force, jace],
    active: [{ auction: lotus.auction, endBlock: lotus.endBlock }, { auction: recall.auction, endBlock: recall.endBlock }],
    bids: [
      { auction: lotus.auction, owner: PAOLO, maxPriceQ96: q(1760), status: "open", submittedAt: now - 7200 },
      { auction: recall.auction, owner: PAOLO, maxPriceQ96: q(700), status: "open", submittedAt: now - 7200 },
    ],
    checkpoints: [
      { auction: lotus.auction, blockNumber: HEAD - 10n, clearingPriceQ96: q(1772), timestamp: now - 120 },
      { auction: recall.auction, blockNumber: HEAD - 10n, clearingPriceQ96: q(662), timestamp: now - 120 },
    ],
    activities: [
      { id: "shard-4", kind: "shard", cardId: 4n, actor: PAOLO, amount: 16n * S, meta: { shardToken: mox.shardToken }, timestamp: now - 7 * 86_400 },
      { id: "settle-4", kind: "settle", cardId: 4n, actor: KENJI, amount: usd(5136), meta: { shardToken: mox.shardToken, graduated: true }, timestamp: now - 1320 },
      { id: "redeem-2", kind: "redeem", cardId: 2n, actor: AIKO, amount: 0n, meta: { shardToken: walk.shardToken }, timestamp: now - 840 },
    ],
    balances: [bal(walk, S, 86_400), bal(force, (27n * S) / 2n, 3600), bal(jace, 13n * S, 3700)],
    payoutClaims: [],
    transfers: [{ id: `${hash(5)}-0`, shardToken: force.shardToken, from: KENJI, to: PAOLO, amount: S / 2n, timestamp: now - 3600 }],
    cardName: (id) => NAMES[Number(id)] ?? `card #${id}`,
    name,
  };
}

const TOAST_ICONS = { bid: GavelIcon, settled: CheckCheckIcon, redeemed: HandCoinsIcon };

/** The three live toasts this task emits, through the same copy function as the websocket hook. */
function liveToasts(): LiveToast[] {
  const ctx: LiveContext = {
    me: PAOLO,
    auctionCard: () => 1n,
    card: (id) => ({ name: NAMES[Number(id)]!, owner: id === 1n || id === 4n ? PAOLO : KENJI }),
    balance: () => S,
    name,
  };
  const meta = { txHash: hash(1), logIndex: 0 };
  const events: LiveEvent[] = [
    { kind: "bid", auction: addr(0x201), bidId: 1n, owner: KENJI, priceQ96: q(1760), amount: usd(2568), ...meta },
    { kind: "settled", cardId: 4n, shardToken: addr(0x104), clearingPriceQ96: q(1712), raisedUsdc: usd(5136), feeUsdc: usd(128.4), graduated: true, ...meta },
    { kind: "redeemed", cardId: 2n, shardToken: addr(0x102), redeemer: AIKO, buyoutPerShard: usd(1840), payoutUsdc: 0n, feeUsdc: 0n, ...meta },
  ];
  return events.map((e) => liveToast(e, ctx)!);
}

export function NotificationsPreview({ state, now }: { state: NotificationPreviewState; now: number }) {
  const rows = state === "empty" ? [] : deriveNotifications(fixture(now));
  // Everything up to 15 minutes ago was read, as in RWhQ9 (the two newest rows carry the dot).
  const [seen, setSeen] = useState(state === "read" ? now : now - 900);
  const unread = new Set(rows.filter((r) => isUnread(r, seen)).map((r) => r.id));
  const toasts = liveToasts();
  return (
    <div className="min-h-screen">
      <TopBar
        homeHref="/app"
        nav={NAV.collector}
        pathname="/app"
        exactHrefs={["/app"]}
        right={
          <>
            <NotificationsMenu
              defaultOpen
              className="max-md:hidden"
              data={{ rows, unread, now, markAllRead: () => setSeen(Math.max(now, ...rows.map((r) => r.time))) }}
              onSelect={(n) => notify({ title: n.title, body: `Would open ${n.href}`, tone: "neutral" })}
            />
            <BarChip icon={CircleDollarSignIcon} className="hidden sm:inline-flex">248.50 USDC</BarChip>
            <span className="inline-flex h-9 items-center rounded-md border border-border px-3"><EnsName name="paolo.kura.eth" copyable={false} /></span>
          </>
        }
      />
      <nav aria-label="Preview states" className="flex flex-wrap gap-2 border-b border-border px-4 py-2 lg:px-12">
        {NOTIFICATION_PREVIEWS.map((s) => (
          <Link key={s} href={`/design/notifications?state=${s}`} className={cn("rounded-full px-2.5 py-1 text-[12px]", s === state ? "bg-surface-2 text-text" : "text-muted-foreground")}>{s}</Link>
        ))}
      </nav>
      <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 pt-6 pb-10 sm:px-6 lg:px-12">
        <p className="max-w-md text-[13px] text-text-2">
          The bell opens on load. Live toasts (bottom right) are what the websocket watcher shows for other people&apos;s events; fire them through sonner:
        </p>
        <div className="flex flex-wrap gap-2">
          {toasts.map((t) => {
            const Icon = TOAST_ICONS[t.icon];
            return (
              <Button key={t.icon} variant="secondary" size="compact" onClick={() => notify({ ...t, icon: <Icon />, duration: 6000, action: { label: t.action.label, onClick: () => {} } })}>
                {t.icon}
              </Button>
            );
          })}
        </div>
      </main>
      <div className="fixed right-4 bottom-4 hidden w-[380px] flex-col gap-2.5 md:flex lg:right-10 lg:bottom-8">
        {toasts.map((t) => {
          const Icon = TOAST_ICONS[t.icon];
          return <KuraToast key={t.icon} title={t.title} body={t.body} tone={t.tone} icon={<Icon />} action={{ label: t.action.label, onClick: () => {} }} />;
        })}
      </div>
    </div>
  );
}
