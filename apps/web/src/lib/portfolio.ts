// The portfolio (QEEV7, YH4Ft, BJyHN, K7qgeI) and My shards (sWbGq, e2yS2e): holdings with cost basis and value, whole
// cards, bids grouped live / ended, allocation and my history on a card. Pure, so node tests cover it.
import { q96ToUsdcPerShard } from "@kura/shared";
import { estimateShards, bidView, type BidView } from "@/lib/bid-math";
import { canRedeem } from "@/lib/card-view";
import { clearingOf } from "@/lib/explore";
import { costBasis, referencePrice, unrealized } from "@/lib/portfolio-math";

type Hex = `0x${string}`;
const SHARD = 10n ** 18n;
const SECONDS_PER_BLOCK = 12;
const lc = (a: string) => a.toLowerCase();

type Card = { id: bigint; state: "whole" | "auctioning" | "sharded" | "released"; ownerOf: Hex; beneficialOwner: Hex; label: string; ensName: string; condition: string; language: string };
type Sharding = {
  shardToken: Hex; cardId: bigint; auction: Hex; totalShards: number; forSale: number; floorPriceQ96: bigint; startBlock: bigint; endBlock: bigint;
  settled: boolean; graduated: boolean | null; clearingPriceQ96: bigint | null; clearingUsdcPerShard: bigint | null;
  buyoutPerShard: bigint | null; redeemer: Hex | null; feeUsdc?: bigint | null;
};
type Balance = { shardToken: Hex; holder: Hex; balance: bigint };
type Bid = {
  id: string; auction: Hex; bidId: bigint; cardId: bigint; owner: Hex; maxPriceQ96: bigint; amountUsdc: bigint; submittedBlock: bigint; submittedAt: number;
  status: "open" | "exited" | "claimed"; tokensFilled: bigint | null; currencyRefunded: bigint | null;
};
type Active = { auction: Hex; endBlock: bigint };
type Activity = { kind: string; cardId: bigint | null; actor: Hex; meta: unknown };
type Ident = { name: string; image: string | null };

/** "12m", "3h", "2d" left at 12 s per block. */
export function shortLeft(blocks: bigint): string {
  const s = Math.max(0, Number(blocks)) * SECONDS_PER_BLOCK;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Whether `me` sharded this sharding: the `shard` activity for its token names me (the card owner at the time). */
export function isSeller(me: string, s: Pick<Sharding, "shardToken" | "cardId">, activities: readonly Activity[]): boolean {
  return activities.some((a) => a.kind === "shard" && lc(a.actor) === lc(me) && a.cardId === s.cardId && lc(String((a.meta as { shardToken?: string } | null)?.shardToken ?? "")) === lc(s.shardToken));
}

/** A sharding's live auction: its active row, before its end block. */
export const isLive = (s: Pick<Sharding, "auction" | "settled">, active: readonly Active[], block: bigint) =>
  !s.settled && active.some((a) => lc(a.auction) === lc(s.auction) && a.endBlock > block);

export type Holding = {
  cardId: bigint;
  shardToken: Hex;
  auction: Hex;
  name: string;
  image: string | null;
  balance: bigint;
  totalShards: number;
  /** balance / (totalShards × 1e18), 0..1 */
  share: number;
  /** What I paid per shard: my average fill (buyer), else the floor of my sharding (seller); null when unknown. */
  cost: bigint | null;
  costKind: "avg" | "floor" | null;
  /** Reference price per shard (referencePrice); null when n/a. */
  price: bigint | null;
  value: bigint | null;
  gain: bigint | null;
  redeemable: boolean;
  /** Blocks left while the auction runs, else null. */
  liveLeft: bigint | null;
  seller: boolean;
};

/** My live holdings (balance > 0) outside bought-out shardings, biggest value first. */
export function holdings(p: {
  me: string;
  balances: readonly Balance[];
  shardings: readonly Sharding[];
  cards: readonly Card[];
  bids: readonly Bid[];
  activities: readonly Activity[];
  active: readonly Active[];
  block: bigint;
  ident: (cardId: bigint) => Ident;
}): Holding[] {
  const byToken = new Map(p.shardings.map((s) => [lc(s.shardToken), s]));
  const out: Holding[] = [];
  for (const b of p.balances) {
    if (lc(b.holder) !== lc(p.me) || b.balance <= 0n) continue;
    const s = byToken.get(lc(b.shardToken));
    if (!s || s.redeemer) continue;
    const live = isLive(s, p.active, p.block);
    const mine = p.bids.filter((x) => lc(x.auction) === lc(s.auction) && lc(x.owner) === lc(p.me));
    const avg = costBasis(mine);
    const seller = isSeller(p.me, s, p.activities);
    const cost = avg ?? (seller ? q96ToUsdcPerShard(s.floorPriceQ96) : null);
    const price = referencePrice({ ...s, clearingUsdcPerShard: live ? clearingOf(s) : s.clearingUsdcPerShard });
    const supply = BigInt(s.totalShards) * SHARD;
    const { name, image } = p.ident(s.cardId);
    out.push({
      cardId: s.cardId, shardToken: s.shardToken, auction: s.auction, name, image, balance: b.balance, totalShards: s.totalShards,
      share: supply > 0n ? Number((b.balance * 1_000_000n) / supply) / 1_000_000 : 0,
      cost, costKind: avg != null ? "avg" : cost != null ? "floor" : null,
      price, value: price != null ? (price * b.balance) / SHARD : null,
      gain: price != null && cost != null ? unrealized(price, cost, b.balance) : null,
      redeemable: canRedeem(b.balance, supply),
      liveLeft: live ? (p.active.find((a) => lc(a.auction) === lc(s.auction))!.endBlock - p.block) : null,
      seller,
    });
  }
  return out.sort((a, b) => ((b.value ?? -1n) > (a.value ?? -1n) ? 1 : (b.value ?? -1n) < (a.value ?? -1n) ? -1 : 0));
}

/** Shardings bought out by someone, where I still hold shards (by the indexer): the payout banners. */
export function payouts<S extends Sharding>(me: string, balances: readonly Balance[], shardings: readonly S[]): S[] {
  const mine = new Set(balances.filter((b) => lc(b.holder) === lc(me) && b.balance > 0n).map((b) => lc(b.shardToken)));
  return shardings.filter((s) => s.redeemer && s.buyoutPerShard != null && lc(s.redeemer) !== lc(me) && mine.has(lc(s.shardToken)));
}

export type WholeCard = { cardId: bigint; name: string; image: string | null; condition: string; value: bigint | null };

/** Cards I hold whole (ownerOf is me: an escrowed card's ownerOf is the vault), and the ones I took home. */
export function wholeCards(me: string, cards: readonly Card[], ident: (id: bigint) => Ident, market: (id: bigint) => bigint | null) {
  const row = (c: Card): WholeCard => ({ cardId: c.id, ...ident(c.id), condition: c.condition, value: market(c.id) });
  const mine = cards.filter((c) => lc(c.ownerOf) === lc(me));
  return { whole: mine.filter((c) => c.state === "whole").map(row), released: mine.filter((c) => c.state === "released").map(row) };
}

export type BidLine = { text: string; tone: "good" | "shu" | "muted" | "kin" };
export type BidItem = {
  bid: Bid;
  cardId: bigint;
  name: string;
  image: string | null;
  maxUsdcPerShard: bigint;
  live: boolean;
  line: BidLine;
  /** live: raise (a new bid on the card page); ended: claim (exit and claim through My bids). */
  action: "raise" | "claim" | null;
  view: BidView | null;
  sharding: Sharding | null;
};

/** My bids, live ones first (newest first within each group). */
export function bidItems(p: { me: string; bids: readonly Bid[]; shardings: readonly Sharding[]; active: readonly Active[]; block: bigint; ident: (id: bigint) => Ident }): { live: BidItem[]; ended: BidItem[] } {
  const byAuction = new Map(p.shardings.map((s) => [lc(s.auction), s]));
  const items = p.bids
    .filter((b) => lc(b.owner) === lc(p.me))
    .sort((a, b) => b.submittedAt - a.submittedAt)
    .map((b): BidItem => {
      const s = byAuction.get(lc(b.auction)) ?? null;
      const live = !!s && isLive(s, p.active, p.block);
      const base = { bid: b, cardId: b.cardId, ...p.ident(b.cardId), maxUsdcPerShard: q96ToUsdcPerShard(b.maxPriceQ96), live, sharding: s };
      if (live && s) {
        const clearingQ96 = s.clearingPriceQ96 ?? s.floorPriceQ96;
        if (b.maxPriceQ96 > clearingQ96) {
          const est = estimateShards(b.amountUsdc, clearingOf(s) ?? q96ToUsdcPerShard(clearingQ96));
          return { ...base, line: { text: `In · would get ${shardsText(est)} shards`, tone: "good" }, action: null, view: null };
        }
        if (b.maxPriceQ96 === clearingQ96) return { ...base, line: { text: "At clearing · filling with the other bids", tone: "kin" }, action: null, view: null };
        return { ...base, line: { text: "Out · price passed your max", tone: "shu" }, action: "raise", view: null };
      }
      const filled = b.tokensFilled ?? 0n;
      if (b.status === "claimed") return { ...base, line: { text: `Filled ${shardsText(filled)} shards`, tone: "good" }, action: null, view: null };
      if (b.status === "exited" && filled === 0n) return { ...base, line: { text: `Refunded $${usdcText(b.currencyRefunded ?? b.amountUsdc)}`, tone: "muted" }, action: null, view: null };
      if (!s || !s.settled) return { ...base, line: { text: "Ended · awaiting settle", tone: "muted" }, action: null, view: null };
      const view = bidView(b, { ended: true, graduated: s.graduated, clearingQ96: s.clearingPriceQ96 ?? 0n });
      const text = b.status === "exited" ? `Filled ${shardsText(filled)} shards · claim them`
        : view.action === "take-back" ? `Reserve not met · take back $${usdcText(b.amountUsdc)}`
        : view.label === "outbid" ? "Outbid · take back your budget"
        : `${view.label === "partially filled" ? "Partially filled" : "Filled"} · exit and claim`;
      return { ...base, line: { text, tone: view.tone === "muted" ? "muted" : "good" }, action: view.action === "none" ? null : "claim", view };
    });
  return { live: items.filter((i) => i.live), ended: items.filter((i) => !i.live) };
}

/** Shards with 2 decimals, trailing zeros trimmed to one ("0.29", "1.5", "2.0"). */
function shardsText(units: bigint): string {
  const hundredths = (units * 100n) / SHARD;
  const s = `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
  return s.endsWith("0") ? s.slice(0, -1) : s;
}
const usdcText = (x: bigint) => (Number(x / 10_000n) / 100).toFixed(2);

export type Totals = { value: bigint; gain: bigint; cards: number };

/** Portfolio value: every holding's value plus every whole card's market value; the gain over holdings with both prices. */
export function totals(h: readonly Holding[], whole: readonly WholeCard[]): Totals {
  const value = h.reduce((a, x) => a + (x.value ?? 0n), 0n) + whole.reduce((a, w) => a + (w.value ?? 0n), 0n);
  const withGain = h.filter((x) => x.gain != null);
  return { value, gain: withGain.reduce((a, x) => a + x.gain!, 0n), cards: withGain.length };
}

export const ALLOCATION_COLORS = ["var(--kura-s1)", "var(--kura-s3)", "var(--kura-s4)", "var(--kura-s7)", "var(--kura-s2)", "var(--kura-s5)"] as const;

/** Each holding's and whole card's share of the portfolio value, biggest first, coloured s1…. */
export function allocation(h: readonly Holding[], whole: readonly WholeCard[]): { name: string; share: number; color: string }[] {
  const parts = [...h.map((x) => ({ name: x.name, value: x.value ?? 0n })), ...whole.map((w) => ({ name: w.name, value: w.value ?? 0n }))].filter((x) => x.value > 0n);
  const total = parts.reduce((a, x) => a + x.value, 0n);
  if (total === 0n) return [];
  return parts
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
    .map((x, i) => ({ name: x.name, share: Number((x.value * 1_000_000n) / total) / 1_000_000, color: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length]! }));
}

// ---------------------------------------------------------------------------------------------------------------------
// My shards: history

export type HistoryRow = {
  key: string;
  kind: "shard" | "settle" | "bid" | "exit" | "claim" | "payout" | "redeem" | "transfer" | "verified";
  title: string;
  detail: string;
  /** Signed USDC shown on the right: + received, − paid. */
  amount: bigint | null;
  timestamp: number;
};

type HistActivity = { id: string; kind: string; cardId: bigint | null; actor: Hex; amount: bigint | null; meta: unknown; blockNumber: bigint; logIndex: number; timestamp: number };
const money0 = (x: bigint) => {
  const cents = x % 1_000_000n === 0n;
  const v = Number(x / 10_000n) / 100;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: cents ? 0 : 2, maximumFractionDigits: cents ? 0 : 2 })}`;
};
const big = (v: unknown): bigint | null => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : typeof v === "bigint" ? v : null);

/**
 * "Your history" on this card, newest first by (blockNumber, logIndex): my activities, the settlement of my own sharding
 * (seller) whoever sent it, and "World ID verified" from my bidder binding.
 */
export function historyRows(p: { me: string; cardId: bigint; sharding: Sharding | null; activities: readonly HistActivity[]; binding: { boundAt: number; blockNumber: bigint } | null; seller: boolean }): HistoryRow[] {
  const s = p.sharding;
  const rows: (HistoryRow & { block: bigint; log: number })[] = [];
  for (const a of p.activities) {
    if (a.cardId !== p.cardId) continue;
    const m = (a.meta ?? {}) as Record<string, unknown>;
    const token = typeof m.shardToken === "string" ? m.shardToken : null;
    const mineSettle = a.kind === "settle" && p.seller && s && token && lc(token) === lc(s.shardToken);
    // The settlement is the seller's (whoever sent it); anyone else's own settle call is not their history.
    if (a.kind === "settle" ? !mineSettle : lc(a.actor) !== lc(p.me)) continue;
    const base = { key: a.id, timestamp: a.timestamp, block: a.blockNumber, log: a.logIndex };
    switch (a.kind) {
      case "shard": {
        const total = Number(m.totalShards ?? 0);
        const forSale = Number(m.forSale ?? 0);
        rows.push({ ...base, kind: "shard", title: "Sharded", detail: `kept ${total - forSale} of ${total}`, amount: null });
        rows.push({ ...base, key: `${a.id}-open`, log: a.logIndex + 0.5, kind: "shard", title: "Auction opened", detail: `${forSale} of ${total} shards`, amount: null });
        break;
      }
      case "settle": {
        if (m.graduated === false) rows.push({ ...base, kind: "settle", title: "Auction settled", detail: "reserve not met · refunded", amount: null });
        else {
          const clearing = big(m.clearingUsdcPerShard);
          const fee = s?.feeUsdc ?? null;
          const detail = [`${s?.forSale ?? "?"} shards sold`, clearing != null ? `at ${money0(clearing)}` : null].filter(Boolean).join(" ");
          // What reached the seller: raised less the vault fee.
          rows.push({ ...base, kind: "settle", title: "Auction settled", detail: fee != null ? `${detail} · fee ${money0(fee)}` : detail, amount: a.amount != null ? a.amount - (fee ?? 0n) : null });
        }
        break;
      }
      case "bid": {
        const max = big(m.maxUsdcPerShard);
        rows.push({ ...base, kind: "bid", title: "Bid placed", detail: `${a.amount != null ? money0(a.amount) : ""}${max != null ? ` up to ${money0(max)} per shard` : ""}`, amount: null });
        break;
      }
      case "exit": {
        const filled = big(m.tokensFilled) ?? 0n;
        // Paid: the bid's budget less the refund, from the matching bid activity.
        const placed = p.activities.find((x) => x.kind === "bid" && lc(String((x.meta as { auction?: string } | null)?.auction ?? "")) === lc(String(m.auction ?? "")) && String((x.meta as { bidId?: string } | null)?.bidId) === String(m.bidId));
        const paid = placed?.amount != null ? placed.amount - (a.amount ?? 0n) : null;
        rows.push(filled > 0n
          ? { ...base, kind: "exit", title: "Bid won", detail: `${shardsText(filled)} shards${s?.clearingUsdcPerShard != null ? ` at the ${money0(s.clearingUsdcPerShard)} clearing price` : ""}`, amount: paid != null ? -paid : null }
          : { ...base, kind: "exit", title: "Bid refunded", detail: `${a.amount != null ? money0(a.amount) : ""} back to your wallet`, amount: null });
        break;
      }
      case "claim":
        rows.push({ ...base, kind: "claim", title: "Claimed", detail: `${a.amount != null ? shardsText(a.amount) : "?"} shards to your wallet`, amount: null });
        break;
      case "payout":
        rows.push({ ...base, kind: "payout", title: "Payout claimed", detail: `for ${big(m.shardUnits) != null ? shardsText(big(m.shardUnits)!) : "?"} shards`, amount: a.amount });
        break;
      case "redeem":
        rows.push({ ...base, kind: "redeem", title: "Redeemed", detail: "bought out the other holders", amount: a.amount != null ? -a.amount : null });
        break;
    }
  }
  if (p.binding) rows.push({ key: "verified", kind: "verified", title: "World ID verified", detail: "one human, one bidding wallet", amount: null, timestamp: p.binding.boundAt, block: p.binding.blockNumber, log: -1 });
  return rows
    .sort((a, b) => (a.block !== b.block ? (a.block > b.block ? -1 : 1) : b.log - a.log))
    .map((r): HistoryRow => ({ key: r.key, kind: r.kind, title: r.title, detail: r.detail, amount: r.amount, timestamp: r.timestamp }));
}
