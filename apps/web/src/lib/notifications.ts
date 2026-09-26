// The Notifications panel (RWhQ9): rows derived from the indexer for one collector, and the read state. Pure, so node
// tests cover it.
import { q96ToUsdcPerShard } from "@kura/shared";
import { canRedeem, custodians, pct, shareOf } from "@/lib/card-view";
import { money } from "@/lib/format";
import { cash, shardCount } from "@/lib/live-events";

type Hex = `0x${string}`;
const SHARD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000";
const SECONDS_PER_BLOCK = 12;
/** "Ends soon": at most 50 blocks (about 10 minutes) left. */
export const ENDS_SOON_BLOCKS = 50n;
/** The panel shows at most this many rows. */
export const NOTIFICATION_LIMIT = 20;
const lc = (a: string) => a.toLowerCase();

type Card = { id: bigint; state: string; shardToken: Hex | null };
type Sharding = {
  shardToken: Hex; cardId: bigint; auction: Hex; totalShards: number; floorPriceQ96: bigint; endBlock: bigint; settled: boolean; graduated: boolean | null;
  clearingUsdcPerShard: bigint | null; raisedUsdc: bigint | null; feeUsdc: bigint | null; buyoutPerShard: bigint | null; redeemer: Hex | null; updatedAt: number;
};
type Bid = { auction: Hex; owner: Hex; maxPriceQ96: bigint; status: "open" | "exited" | "claimed"; submittedAt: number };
type Checkpoint = { auction: Hex; blockNumber: bigint; clearingPriceQ96: bigint; timestamp: number };
type Activity = { id: string; kind: string; cardId: bigint | null; actor: Hex; amount: bigint | null; meta: unknown; timestamp: number };
type Balance = { shardToken: Hex; holder: Hex; balance: bigint; updatedAt: number };
type Claim = { shardToken: Hex; holder: Hex };
type Transfer = { id: string; shardToken: Hex; from: Hex; to: Hex; amount: bigint; timestamp: number };
type Active = { auction: Hex; endBlock: bigint };

export type NotificationKind = "outbid" | "payout" | "ends-soon" | "settled" | "received" | "can-redeem";
export type Notification = {
  id: string;
  kind: NotificationKind;
  cardId: bigint;
  title: string;
  body: string;
  /** Unix seconds: when it happened, for "2m" and the unread dot. */
  time: number;
  href: string;
  /** The inline chip (Raise bid / Claim / Redeem). */
  action?: string;
};

export type NotificationInput = {
  me: string;
  block: bigint;
  now: number;
  vault: string;
  cards: readonly Card[];
  shardings: readonly Sharding[];
  active: readonly Active[];
  /** My bids. */
  bids: readonly Bid[];
  /** Checkpoints of the auctions I bid on, any order. */
  checkpoints: readonly Checkpoint[];
  /** shard, settle and redeem activities. */
  activities: readonly Activity[];
  /** My shard balances. */
  balances: readonly Balance[];
  /** My payout claims. */
  payoutClaims: readonly Claim[];
  /** Shard transfers to me. */
  transfers: readonly Transfer[];
  cardName: (id: bigint) => string;
  /** How an address is shown (AddressName). */
  name: (address: string) => string;
};

const tokenOf = (a: Activity) => lc(String((a.meta as { shardToken?: string } | null)?.shardToken ?? ""));
const cardHref = (id: bigint, tab?: string) => `/app/cards/${id}${tab ? `?tab=${tab}` : ""}`;

/**
 * When the auction entered its last 50 blocks, on chain time: the latest checkpoint's timestamp plus 12 s per block
 * from there. Without a checkpoint, from the clock and the indexer's block. Never later than `now`, so the row keeps
 * its time (and its read state) while the indexer lags.
 */
function endsSoonTime(endBlock: bigint, cp: Checkpoint | undefined, now: number, left: bigint): number {
  const t = cp
    ? cp.timestamp + Number(endBlock - ENDS_SOON_BLOCKS - cp.blockNumber) * SECONDS_PER_BLOCK
    : now - Number(ENDS_SOON_BLOCKS - left) * SECONDS_PER_BLOCK;
  return Math.min(t, now);
}

/** Every notification for `me`, newest first (at most NOTIFICATION_LIMIT). */
export function deriveNotifications(p: NotificationInput): Notification[] {
  const me = lc(p.me);
  const out: Notification[] = [];
  const byAuction = new Map(p.shardings.map((s) => [lc(s.auction), s]));
  const byToken = new Map(p.shardings.map((s) => [lc(s.shardToken), s]));
  const balanceOf = new Map(p.balances.filter((b) => lc(b.holder) === me).map((b) => [lc(b.shardToken), b]));
  const live = (auction: string) => {
    const s = byAuction.get(lc(auction));
    return !!s && !s.settled && p.active.some((a) => lc(a.auction) === lc(auction) && a.endBlock > p.block);
  };
  const checkpointsOf = (auction: string) =>
    p.checkpoints.filter((c) => lc(c.auction) === lc(auction)).sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));

  // 1 and 3: my open bids on live auctions, per auction: outbid, or in and ending soon.
  const myOpen = p.bids.filter((b) => lc(b.owner) === me && b.status === "open" && live(b.auction));
  for (const auction of new Set(myOpen.map((b) => lc(b.auction)))) {
    const s = byAuction.get(auction)!;
    const cps = checkpointsOf(auction);
    const latest = cps.at(-1);
    const clearingQ96 = latest?.clearingPriceQ96 ?? s.floorPriceQ96;
    // The best of my bids here. At the clearing price a bid still fills, so only a clearing above my max is "outbid".
    const best = myOpen.filter((b) => lc(b.auction) === auction).reduce((a, b) => (b.maxPriceQ96 > a.maxPriceQ96 ? b : a));
    const name = p.cardName(s.cardId);
    if (latest && best.maxPriceQ96 < latest.clearingPriceQ96) {
      const passed = cps.find((c) => c.clearingPriceQ96 > best.maxPriceQ96) ?? latest;
      out.push({
        id: `outbid-${auction}`,
        kind: "outbid",
        cardId: s.cardId,
        title: `You were outbid on ${name}`,
        body: `Clearing ${money(q96ToUsdcPerShard(latest.clearingPriceQ96), 0)} passed your ${money(q96ToUsdcPerShard(best.maxPriceQ96), 0)} max`,
        time: Math.max(passed.timestamp, best.submittedAt),
        href: cardHref(s.cardId, "auction"),
        action: "Raise bid",
      });
      continue;
    }
    const left = s.endBlock - p.block;
    if (left > 0n && left <= ENDS_SOON_BLOCKS) {
      const minutes = Math.max(1, Math.ceil((Number(left) * SECONDS_PER_BLOCK) / 60));
      out.push({
        id: `ends-${auction}`,
        kind: "ends-soon",
        cardId: s.cardId,
        title: `${name} ends in ${minutes} minute${minutes === 1 ? "" : "s"}`,
        body: `You're in at ${money(q96ToUsdcPerShard(clearingQ96), 0)} per shard`,
        time: endsSoonTime(s.endBlock, latest, p.now, left),
        href: cardHref(s.cardId, "auction"),
      });
    }
  }

  // 2: bought out, I still hold shards and haven't claimed.
  const claimed = new Set(p.payoutClaims.filter((c) => lc(c.holder) === me).map((c) => lc(c.shardToken)));
  for (const s of p.shardings) {
    if (!s.redeemer || s.buyoutPerShard == null || lc(s.redeemer) === me) continue;
    const bal = balanceOf.get(lc(s.shardToken));
    if (!bal || bal.balance <= 0n || claimed.has(lc(s.shardToken))) continue;
    const redeem = p.activities.find((a) => a.kind === "redeem" && tokenOf(a) === lc(s.shardToken));
    out.push({
      id: `payout-${lc(s.shardToken)}`,
      kind: "payout",
      cardId: s.cardId,
      title: `Payout ready: ${cash((bal.balance * s.buyoutPerShard) / SHARD)}`,
      body: `${p.cardName(s.cardId)} was bought out by ${p.name(s.redeemer)}`,
      time: redeem?.timestamp ?? s.updatedAt,
      href: cardHref(s.cardId),
      action: "Claim",
    });
  }

  // 4: an auction I started settled.
  const mySharded = new Set(p.activities.filter((a) => a.kind === "shard" && lc(a.actor) === me).map(tokenOf));
  for (const a of p.activities) {
    if (a.kind !== "settle" || a.cardId == null || !mySharded.has(tokenOf(a))) continue;
    const s = byToken.get(tokenOf(a));
    const graduated = s?.graduated ?? (a.meta as { graduated?: boolean } | null)?.graduated ?? false;
    const raised = s?.raisedUsdc ?? a.amount ?? 0n;
    const perShard = s?.clearingUsdcPerShard ?? null;
    const name = p.cardName(a.cardId);
    const body = graduated
      ? `${perShard ? `${shardCount((raised * SHARD) / perShard)} ` : ""}${name} shards sold · +${cash(raised - (s?.feeUsdc ?? 0n))}`
      : "Reserve not met · bids refunded";
    out.push({ id: `settled-${a.id}`, kind: "settled", cardId: a.cardId, title: "Your auction settled", body, time: a.timestamp, href: cardHref(a.cardId, "auction") });
  }

  // 5: shards someone sent me (not the auction, the vault or a mint).
  const held = custodians(p.shardings, p.vault);
  for (const tr of p.transfers) {
    if (lc(tr.to) !== me || lc(tr.from) === ZERO || lc(tr.from) === me || held.has(lc(tr.from))) continue;
    const s = byToken.get(lc(tr.shardToken));
    if (!s) continue;
    const now = balanceOf.get(lc(tr.shardToken))?.balance ?? 0n;
    out.push({
      id: `received-${tr.id}`,
      kind: "received",
      cardId: s.cardId,
      title: `${p.name(tr.from)} sent you ${shardCount(tr.amount)} shard${tr.amount > SHARD ? "s" : ""}`,
      body: `${p.cardName(s.cardId)} · you now hold ${shardCount(now)}`,
      time: tr.timestamp,
      href: cardHref(s.cardId),
    });
  }

  // 6: I hold enough of a sharded card to redeem it.
  for (const c of p.cards) {
    if (c.state !== "sharded" || !c.shardToken) continue;
    const s = byToken.get(lc(c.shardToken));
    const bal = balanceOf.get(lc(c.shardToken));
    if (!s || !bal) continue;
    const supply = BigInt(s.totalShards) * SHARD;
    if (!canRedeem(bal.balance, supply)) continue;
    out.push({
      id: `redeem-${lc(c.shardToken)}`,
      kind: "can-redeem",
      cardId: c.id,
      title: `You can redeem ${p.cardName(c.id)}`,
      body: `You hold ${pct(shareOf(bal.balance, supply))} of the shards`,
      time: bal.updatedAt,
      href: cardHref(c.id),
      action: "Redeem",
    });
  }

  return out.sort((a, b) => b.time - a.time).slice(0, NOTIFICATION_LIMIT);
}

// ---------------------------------------------------------------------------------------------------------------------
// Read state: the last time "Mark all read" was pressed, per address, in localStorage.

const seenKey = (address: string) => `kura.notif.seen.${lc(address)}`;

/** The last-seen unix time for `address` (0 when never, or when storage is unavailable). */
export function readSeen(address: string): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(seenKey(address)));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** Stores the last-seen time; ignored when storage is unavailable. */
export function writeSeen(address: string, time: number): void {
  try {
    globalThis.localStorage?.setItem(seenKey(address), String(time));
  } catch {
    /* private mode or blocked storage: the dots come back next visit */
  }
}

/** A row is unread when it happened after the last "Mark all read". */
export const isUnread = (n: Pick<Notification, "time">, seen: number) => n.time > seen;
