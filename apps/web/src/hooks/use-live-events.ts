"use client";

import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { eq } from "@ponder/client";
import { usePonderQuery } from "@ponder/react";
import { CheckCheckIcon, GavelIcon, HandCoinsIcon } from "lucide-react";
import type { Address } from "viem";
import { notify } from "@/components/kura";
import { useAttributes, useIndexerBlock } from "@/hooks/use-explore";
import { displayName, useHandles } from "@/hooks/use-handles";
import { useKuraUser } from "@/hooks/use-kura-user";
import { addresses, wsClient } from "@/lib/chain";
import {
  labelName,
  liveAuctionsKey,
  liveEventFilter,
  liveToast,
  subscribeLiveEvents,
  type LiveContext,
  type LiveEvent,
  type LiveToast,
  type WatchClient,
} from "@/lib/live-events";
import { schema, t, type Row } from "@/lib/ponder";

export { subscribeLiveEvents, type LiveEvent };

type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];
type CardRow = Row<typeof schema.cards>;
type ActiveRow = Row<typeof schema.activeAuctions>;
type BalanceRow = Row<typeof schema.shardBalances>;

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const ICONS: Record<LiveToast["icon"], typeof GavelIcon> = { bid: GavelIcon, settled: CheckCheckIcon, redeemed: HandCoinsIcon };

// Module level: usePonderQuery re-subscribes whenever the query function changes. Same SQL as the other hooks'
// cards / activeAuctions reads, so they share the cache.
const cardsQuery = (db: Db) => db.select().from(t(schema.cards)) as Promise<CardRow[]>;
const activeQuery = (db: Db) => db.select().from(t(schema.activeAuctions)) as Promise<ActiveRow[]>;

/** The websocket URL is optional: without it there are no live toasts (Ponder live queries still update the UI). */
const liveEventsEnabled = () => !!process.env.NEXT_PUBLIC_ALCHEMY_WS_URL;

/**
 * Toasts other people's bids on live auctions, settlements and buyouts as they land on chain, through the websocket
 * client. Keyed on the sorted live auction addresses: re-subscribes when that set changes, stops on unmount. Skips
 * this tab's own transactions (TxStepper confirms those) and events whose actor is me. Signed-in users only. Mount it
 * once per shell (the collector and vendor layouts, which never nest).
 */
export function useLiveEvents(): void {
  const { ready: userReady, authenticated, address: me } = useKuraUser();
  // Signed-in shells only: the login screens stay quiet.
  const on = liveEventsEnabled() && userReady && authenticated;
  const router = useRouter();
  const handles = useHandles();
  const block = useIndexerBlock();
  const active = usePonderQuery({ queryFn: activeQuery, enabled: on });
  const cards = usePonderQuery({ queryFn: cardsQuery, enabled: on });
  const wallet = (me ?? ZERO).toLowerCase();
  // The portfolio's own balances read (same SQL), so the cache is shared.
  const balances = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.shardBalances)).where(eq(t(schema.shardBalances.holder), wallet)) as Promise<BalanceRow[]>, [wallet]),
    enabled: on && !!me,
  });
  const cardRows = cards.data ?? [];
  // The same id set as the analytics dashboard's attributes read, so the batched request is shared.
  const attributes = useAttributes(on ? cardRows.filter((c) => c.state !== "released").map((c) => c.scryfallId) : []);

  // The toast copy reads the latest data through a ref, so new rows never re-subscribe.
  const ctx = useRef<LiveContext | null>(null);
  const push = useRef(router.push);
  const latest: LiveContext = {
    me,
    auctionCard: (auction) => (active.data ?? []).find((a) => a.auction.toLowerCase() === auction.toLowerCase())?.cardId ?? null,
    card: (id) => {
      const c = cardRows.find((r) => r.id === id);
      return c ? { name: attributes[c.scryfallId]?.name || labelName(c.label), owner: c.beneficialOwner } : null;
    },
    balance: (token) => (balances.data ?? []).find((b) => b.shardToken.toLowerCase() === token.toLowerCase())?.balance ?? 0n,
    name: (a) => displayName(a, handles, addresses),
  };
  useEffect(() => {
    ctx.current = latest;
    push.current = router.push;
  });
  // Kept across re-subscriptions, so a replayed log is still recognised.
  const [filter] = useState(() => liveEventFilter());

  const ready = on && block != null && active.isSuccess;
  const key = ready ? liveAuctionsKey(active.data ?? [], block) : null;
  useEffect(() => {
    if (key == null) return;
    try {
      return subscribeLiveEvents(wsClient() as unknown as WatchClient, {
        auctions: key ? (key.split(",") as Address[]) : [],
        vault: addresses.cardVault,
        onEvent: (e) => {
          if (!ctx.current || !filter(e, ctx.current.me)) return;
          const toast = liveToast(e, ctx.current);
          if (!toast) return;
          notify({
            title: toast.title,
            body: toast.body,
            tone: toast.tone,
            icon: createElement(ICONS[toast.icon]),
            duration: 6000,
            action: { label: toast.action.label, onClick: () => push.current(toast.action.href) },
          });
        },
      });
    } catch {
      // No websocket (bad URL, no WebSocket in this browser): stay silent, the live queries still update the UI.
      return undefined;
    }
  }, [key, filter]);
}
