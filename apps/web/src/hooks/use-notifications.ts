"use client";

import { useCallback, useMemo, useState } from "react";
import { desc, eq, inArray } from "@ponder/client";
import { usePonderQuery } from "@ponder/react";
import { useAttributes, useIndexerBlock } from "@/hooks/use-explore";
import { displayName, useHandles } from "@/hooks/use-handles";
import { useNow } from "@/hooks/use-now";
import { useShardings, useVaultCards } from "@/hooks/use-vendor-data";
import { addresses } from "@/lib/chain";
import { labelName } from "@/lib/live-events";
import { deriveNotifications, isUnread, readSeen, writeSeen, type Notification } from "@/lib/notifications";
import { schema, t, type Row } from "@/lib/ponder";

type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];
type Hex = `0x${string}`;
type ActiveRow = Row<typeof schema.activeAuctions>;
type BidRow = Row<typeof schema.bids>;
type BalanceRow = Row<typeof schema.shardBalances>;
type ClaimRow = Row<typeof schema.payoutClaims>;
type TransferRow = Row<typeof schema.shardTransfers>;
type ActivityRow = Row<typeof schema.activities>;
type CheckpointRow = Row<typeof schema.checkpoints>;

const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
// Module level: usePonderQuery re-subscribes whenever the query function changes.
const activeQuery = (db: Db) => db.select().from(t(schema.activeAuctions)) as Promise<ActiveRow[]>;
const activitiesQuery = (db: Db) =>
  db.select().from(t(schema.activities)).where(inArray(t(schema.activities.kind), ["shard", "settle", "redeem"]))
    .orderBy(desc(t(schema.activities.timestamp))).limit(500) as Promise<ActivityRow[]>;

export type NotificationsData = {
  rows: Notification[];
  /** Rows newer than the last "Mark all read". */
  unread: Set<string>;
  markAllRead: () => void;
  now: number;
  isLoading: boolean;
};

/**
 * The Notifications panel's rows for `me`, live from the indexer: my bids, balances, payout claims and incoming
 * transfers (filtered by me), plus the vault's shardings, cards, live auctions and shard / settle / redeem activities.
 * Card names come from the one batched attributes read.
 */
export function useNotifications(me: string): NotificationsData {
  const wallet = (me || ZERO).toLowerCase() as Hex;
  const cards = useVaultCards();
  const shardings = useShardings();
  const active = usePonderQuery({ queryFn: activeQuery });
  const activities = usePonderQuery({ queryFn: activitiesQuery });
  // The portfolio's own reads (same SQL), so the cache is shared.
  const bids = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.bids)).where(eq(t(schema.bids.owner), wallet)).orderBy(desc(t(schema.bids.submittedAt))) as Promise<BidRow[]>, [wallet]),
  });
  const balances = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.shardBalances)).where(eq(t(schema.shardBalances.holder), wallet)) as Promise<BalanceRow[]>, [wallet]),
  });
  const claims = usePonderQuery({
    queryFn: useCallback((db: Db) => db.select().from(t(schema.payoutClaims)).where(eq(t(schema.payoutClaims.holder), wallet)) as Promise<ClaimRow[]>, [wallet]),
  });
  const transfers = usePonderQuery({
    queryFn: useCallback(
      (db: Db) => db.select().from(t(schema.shardTransfers)).where(eq(t(schema.shardTransfers.to), wallet)).orderBy(desc(t(schema.shardTransfers.timestamp))).limit(100) as Promise<TransferRow[]>,
      [wallet],
    ),
  });
  const bidAuctions = [...new Set((bids.data ?? []).filter((b) => b.status === "open").map((b) => b.auction.toLowerCase()))].sort();
  const auctionsKey = bidAuctions.join(",");
  const checkpoints = usePonderQuery({
    queryFn: useCallback(
      (db: Db) => db.select().from(t(schema.checkpoints)).where(inArray(t(schema.checkpoints.auction), bidAuctions.length > 0 ? bidAuctions : [ZERO])) as Promise<CheckpointRow[]>,
      // eslint-disable-next-line react-hooks/exhaustive-deps -- auctionsKey is the stable identity of `bidAuctions`
      [auctionsKey],
    ),
  });
  const block = useIndexerBlock();
  const now = useNow(30_000);
  const handles = useHandles();
  const cardRows = useMemo(() => cards.data ?? [], [cards.data]);
  // The same id set as the other shells' attributes read, so the batched request is shared.
  const attributes = useAttributes(cardRows.filter((c) => c.state !== "released").map((c) => c.scryfallId));
  const [seen, setSeen] = useState(() => readSeen(wallet));
  const [seenFor, setSeenFor] = useState(wallet);
  if (seenFor !== wallet) {
    setSeenFor(wallet);
    setSeen(readSeen(wallet));
  }

  const isLoading = cards.isLoading || shardings.isLoading || active.isLoading || bids.isLoading || balances.isLoading || block == null;
  const rows = !me || block == null ? [] : deriveNotifications({
    me: wallet,
    block,
    now,
    vault: addresses.cardVault,
    cards: cardRows,
    shardings: shardings.data ?? [],
    active: active.data ?? [],
    bids: bids.data ?? [],
    checkpoints: checkpoints.data ?? [],
    activities: activities.data ?? [],
    balances: balances.data ?? [],
    payoutClaims: claims.data ?? [],
    transfers: transfers.data ?? [],
    cardName: (id) => {
      const c = cardRows.find((r) => r.id === id);
      return c ? attributes[c.scryfallId]?.name || labelName(c.label) : `card #${id}`;
    },
    name: (a) => displayName(a, handles, addresses),
  });
  const unread = new Set(rows.filter((r) => isUnread(r, seen)).map((r) => r.id));
  const markAllRead = () => {
    // At least the newest row's time, so an event stamped slightly ahead of this clock still reads as seen.
    const t = Math.max(Math.floor(Date.now() / 1000), ...rows.map((r) => r.time));
    writeSeen(wallet, t);
    setSeen(t);
  };
  return { rows, unread, markAllRead, now, isLoading };
}
