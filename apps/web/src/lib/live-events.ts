// Live chain events for the toasts (F0tov, RWhQ9): the websocket subscriptions, the dedupe / own-tx filter and the
// toast copy. No React, so node tests cover it.
import { abi, q96ToUsdcPerShard } from "@kura/shared";
import type { Address, Hex } from "viem";
import { money } from "@/lib/format";
import { boundedSet, isOwnTx } from "@/lib/tx-core";

const SHARD = 10n ** 18n;
const lc = (a: string) => a.toLowerCase();

type LogMeta = { txHash: Hex | null; logIndex: number | null };
export type LiveEvent =
  | ({ kind: "bid"; auction: Address; bidId: bigint; owner: Address; priceQ96: bigint; amount: bigint } & LogMeta)
  | ({ kind: "settled"; cardId: bigint; shardToken: Address; clearingPriceQ96: bigint; raisedUsdc: bigint; feeUsdc: bigint; graduated: boolean } & LogMeta)
  | ({ kind: "redeemed"; cardId: bigint; shardToken: Address; redeemer: Address; buyoutPerShard: bigint; payoutUsdc: bigint; feeUsdc: bigint } & LogMeta);

/** The one method of a viem PublicClient the subscriptions use. */
export type WatchClient = { watchContractEvent: (args: unknown) => () => void };

type Log<A> = { args: A; transactionHash: Hex | null; logIndex: number | null; removed?: boolean };
const meta = (l: Log<unknown>): LogMeta => ({ txHash: l.transactionHash ?? null, logIndex: l.logIndex ?? null });

/**
 * Watches `BidSubmitted` on each auction, and `AuctionSettled` and `CardRedeemed` on the vault. Returns one function
 * that stops every subscription. Errors (a dropped socket) go to `onError`, silent by default.
 */
export function subscribeLiveEvents(
  client: WatchClient,
  deps: { auctions: readonly Address[]; vault: Address; onEvent: (e: LiveEvent) => void; onError?: (e: unknown) => void },
): () => void {
  const onError = deps.onError ?? (() => {});
  const each = <A>(logs: Log<A>[], f: (l: Log<A>) => LiveEvent) => {
    for (const l of logs) if (!l.removed) deps.onEvent(f(l));
  };
  const stops = deps.auctions.map((auction) =>
    client.watchContractEvent({
      address: auction,
      abi: abi.ccaAuction,
      eventName: "BidSubmitted",
      onError,
      onLogs: (logs: Log<{ id: bigint; owner: Address; priceQ96: bigint; amount: bigint }>[]) =>
        each(logs, (l) => ({ kind: "bid", auction, bidId: l.args.id, owner: l.args.owner, priceQ96: l.args.priceQ96, amount: l.args.amount, ...meta(l) })),
    }),
  );
  stops.push(
    client.watchContractEvent({
      address: deps.vault,
      abi: abi.cardVault,
      eventName: "AuctionSettled",
      onError,
      onLogs: (logs: Log<{ id: bigint; shardToken: Address; clearingPriceQ96: bigint; raisedUsdc: bigint; feeUsdc: bigint; graduated: boolean }>[]) =>
        each(logs, (l) => ({ kind: "settled", cardId: l.args.id, ...l.args, ...meta(l) })),
    }),
    client.watchContractEvent({
      address: deps.vault,
      abi: abi.cardVault,
      eventName: "CardRedeemed",
      onError,
      onLogs: (logs: Log<{ id: bigint; shardToken: Address; redeemer: Address; buyoutPerShard: bigint; payoutUsdc: bigint; feeUsdc: bigint }>[]) =>
        each(logs, (l) => ({ kind: "redeemed", cardId: l.args.id, ...l.args, ...meta(l) })),
    }),
  );
  return () => stops.forEach((s) => s());
}

/** The sorted addresses of the auctions still taking bids (`endBlock > block`), joined: the subscription key. */
export function liveAuctionsKey(active: readonly { auction: string; endBlock: bigint }[], block: bigint): string {
  return active.filter((a) => a.endBlock > block).map((a) => lc(a.auction)).sort().join(",");
}

/** Who caused the event, when the event names them: the bidder or the redeemer (settle is permissionless). */
function actorOf(e: LiveEvent): string | null {
  return e.kind === "bid" ? e.owner : e.kind === "redeemed" ? e.redeemer : null;
}

/**
 * A stateful filter: false for a log already seen (`txHash-logIndex`; a reconnect can replay logs), for a transaction
 * this tab sent (TxStepper already confirmed it) and for an event whose actor is me.
 */
export function liveEventFilter(limit = 200): (e: LiveEvent, me: string | null | undefined) => boolean {
  const seen = boundedSet(limit);
  return (e, self) => {
    if (e.txHash != null && e.logIndex != null) {
      const key = `${lc(e.txHash)}-${e.logIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    if (isOwnTx(e.txHash)) return false;
    const actor = actorOf(e);
    return !(actor && self && lc(actor) === lc(self));
  };
}

/** A card label's name part, for while the attributes load: "black-lotus-lea-1" → "Black Lotus". */
export function labelName(label: string): string {
  const parts = label.split("-").filter(Boolean);
  const words = parts.length >= 3 ? parts.slice(0, -2) : parts;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Shards to at most 2 decimals, trailing zeros dropped ("3", "0.5", "2.25"). */
export function shardCount(units: bigint): string {
  return String(Number((Number(units) / 1e18).toFixed(2)));
}

/** Money with two decimals ("$1,840.00", "$0.22"); kept as the live-toast name for `money`. */
export const cash = (x: bigint) => money(x);

export type LiveContext = {
  me: string | null;
  /** The card an auction sells. */
  auctionCard: (auction: string) => bigint | null;
  /** The card's display name and its owner (`cards.beneficialOwner`). */
  card: (id: bigint) => { name: string; owner: string } | null;
  /** My balance of a shard token (0 when none). */
  balance: (shardToken: string) => bigint;
  /** How an address is shown (AddressName). */
  name: (address: string) => string;
};

export type LiveToast = {
  title: string;
  body: string;
  tone: "shu" | "good" | "kin";
  icon: "bid" | "settled" | "redeemed";
  action: { label: string; href: string };
};

const cardHref = (id: bigint, tab?: string) => `/app/cards/${id}${tab ? `?tab=${tab}` : ""}`;

/** The toast for a live event (the controller's copy table), or null when its card is unknown. */
export function liveToast(e: LiveEvent, ctx: LiveContext): LiveToast | null {
  const cardId = e.kind === "bid" ? ctx.auctionCard(e.auction) : e.cardId;
  if (cardId == null) return null;
  const card = ctx.card(cardId);
  const name = card?.name ?? `card #${cardId}`;
  const mine = !!card && !!ctx.me && lc(card.owner) === lc(ctx.me);
  if (e.kind === "bid") {
    return {
      title: mine ? `New bid on your ${name}` : `New bid on ${name}`,
      body: `${ctx.name(e.owner)} · ${money(e.amount)} up to ${money(q96ToUsdcPerShard(e.priceQ96))}`,
      tone: "shu",
      icon: "bid",
      action: { label: "View", href: cardHref(cardId, "auction") },
    };
  }
  if (e.kind === "settled") {
    const perShard = q96ToUsdcPerShard(e.clearingPriceQ96);
    const body = e.graduated
      ? `${perShard > 0n ? `${shardCount((e.raisedUsdc * SHARD) / perShard)} ` : ""}${name} shards sold · ${cash(e.raisedUsdc)}`
      : "Reserve not met · bids refunded";
    return { title: mine ? "Your auction settled" : "Auction settled", body, tone: "good", icon: "settled", action: { label: "View", href: cardHref(cardId, "auction") } };
  }
  const held = ctx.balance(e.shardToken);
  const by = ctx.name(e.redeemer);
  return {
    title: `${name} was bought out`,
    body: held > 0n ? `Payout ready: ${cash((held * e.buyoutPerShard) / SHARD)} · by ${by}` : `by ${by} at ${cash(e.buyoutPerShard)}/shard`,
    tone: "kin",
    icon: "redeemed",
    // The payout panel sits on the card page's overview, under the card header.
    action: held > 0n ? { label: "Claim", href: cardHref(cardId) } : { label: "View", href: cardHref(cardId) },
  };
}
