// Dev-only fixtures for /design/card, shaped exactly like the indexer rows (apps/indexer/ponder.schema.ts): 18-decimal
// shard units, 6-decimal USDC, activities by (blockNumber, logIndex), shard transfers keyed "<txHash>-<logIndex>".
import { usdcPerShardToQ96 } from "@kura/shared";
import type { ActivityRow, BalanceRow, BidRow, CardData, CheckpointRow, EnsRecordRow, ShardingRow, TickRow, TransferRow } from "@/hooks/use-card";
import { addresses } from "@/lib/chain";
import type { Handles } from "@/lib/handles";

type Hex = `0x${string}`;
const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

export const PAOLO: Hex = "0x4f2c6e1a0b3d5f7a9c1e3b5d7f9a1c3e5b7da81e";
export const KENJI: Hex = "0x1ee0b7a3c5e7f9a1b3c5d7e9f1a3b5c7d9e14b3c";
export const X7A3: Hex = "0x7a3f00d1e2c3b4a5968778695a4b3c2d1e0f91c2";
export const AIKO: Hex = "0xa1c0e5d4c3b2a1908f7e6d5c4b3a29181716a1c0";
export const HANDLES: Handles = { [PAOLO.toLowerCase()]: "paolo", [KENJI.toLowerCase()]: "kenji", [AIKO.toLowerCase()]: "aiko" };

const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const TOKEN: Hex = addr(0x5a1d);
const AUCTION: Hex = addr(0xa0c7);
const NODE: Hex = "0x0589af38c4cac3fc62158359a92d9722514d83c7e1afe9aeb0a84b9df1fa59a8";
const S = 10n ** 18n;
const usd = (dollars: number) => BigInt(Math.round(dollars * 100)) * 10_000n;

export const PREVIEW_STATES = ["whole-owner", "whole", "auctioning", "sharded", "released", "empty", "loading", "notfound"] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

/** Blocks at 12 s: the fixture's "now" is block HEAD at `now` seconds. */
const HEAD = 7_412_880n;

export function cardFixture(state: PreviewState, now: number): CardData {
  const at = (secondsAgo: number) => now - secondsAgo;
  const blockAgo = (secondsAgo: number) => HEAD - BigInt(Math.floor(secondsAgo / 12));
  const whole = state === "whole" || state === "whole-owner" || state === "empty";
  const auctioning = state === "auctioning";
  const released = state === "released";
  const owner = state === "whole" ? KENJI : PAOLO;

  const card = {
    id: 1n,
    state: whole ? ("whole" as const) : auctioning ? ("auctioning" as const) : released ? ("released" as const) : ("sharded" as const),
    ownerOf: whole || released ? owner : addresses.cardVault,
    beneficialOwner: owner,
    scryfallId: "b0faa7f2-b547-42c4-a810-839da50dadfe",
    condition: "NM",
    language: "en",
    label: "black-lotus-lea-1",
    ensName: "black-lotus-lea-1.kura.eth",
    shardToken: whole ? null : TOKEN,
    auction: whole ? null : AUCTION,
    endBlock: whole ? null : auctioning ? HEAD + 21n : blockAgo(23 * 60),
    mintedAt: at(7 * 86_400 + 600),
    updatedBlock: HEAD,
    updatedAt: at(60),
  } satisfies NonNullable<CardData["card"]>;

  const MINT = { b: blockAgo(7 * 86_400 + 600), ts: at(7 * 86_400 + 600) };
  const SHARD_AT = { b: blockAgo(auctioning ? 14 * 60 : 7 * 86_400), ts: at(auctioning ? 14 * 60 : 7 * 86_400) };
  const startBlock = SHARD_AT.b + 1n;
  const endBlock = auctioning ? HEAD + 21n : startBlock + 50_400n; // one week of blocks

  const sharding: ShardingRow = {
    shardToken: TOKEN,
    cardId: 1n,
    auction: AUCTION,
    totalShards: 16,
    forSale: 3,
    floorPriceQ96: usdcPerShardToQ96(usd(1560)),
    tickSpacingQ96: usdcPerShardToQ96(usd(20)),
    reserveUsdc: usd(4680),
    startBlock,
    endBlock,
    settled: !auctioning,
    graduated: auctioning ? null : true,
    clearingPriceQ96: usdcPerShardToQ96(usd(1712)),
    clearingUsdcPerShard: auctioning ? null : usd(1712),
    raisedUsdc: auctioning ? null : usd(5136),
    feeUsdc: auctioning ? null : usd(128.4),
    buyoutPerShard: released ? usd(1712) : null,
    payoutUsdc: released ? usd(5136) : null,
    redeemer: released ? PAOLO : null,
    createdAt: SHARD_AT.ts,
    updatedBlock: HEAD,
    updatedAt: at(60),
  };

  let li = 0;
  const act = (kind: ActivityRow["kind"], actor: Hex, secondsAgo: number, amount: bigint | null, meta: unknown, block?: bigint): ActivityRow => {
    li += 1;
    const b = block ?? blockAgo(secondsAgo);
    return { id: `${hash(li)}-${li}`, kind, cardId: 1n, actor, amount, meta, txHash: hash(li), blockNumber: b, logIndex: li, timestamp: at(secondsAgo) };
  };
  const activities: ActivityRow[] = [
    act("named", PAOLO, 7 * 86_400 + 600, null, { label: card.label, node: NODE }, MINT.b),
    act("mint", PAOLO, 7 * 86_400 + 600, null, { label: card.label }, MINT.b),
  ];
  const transfers: TransferRow[] = [];
  const bids: BidRow[] = [];
  const tr = (from: Hex, to: Hex, amount: bigint, secondsAgo: number) => {
    li += 1;
    transfers.push({ id: `${hash(li)}-${li}`, shardToken: TOKEN, from, to, amount, blockNumber: blockAgo(secondsAgo), timestamp: at(secondsAgo) });
  };
  const bid = (owner: Hex, amountUsd: number, maxUsd: number, secondsAgo: number, status: BidRow["status"], filled: bigint | null) => {
    const a = act("bid", owner, secondsAgo, usd(amountUsd), { auction: AUCTION, bidId: String(bids.length + 1), maxUsdcPerShard: usd(maxUsd).toString() });
    activities.push(a);
    bids.push({
      id: `${AUCTION}-${bids.length + 1}`, auction: AUCTION, bidId: BigInt(bids.length + 1), cardId: 1n, shardToken: TOKEN, owner,
      maxPriceQ96: usdcPerShardToQ96(usd(maxUsd)), amountUsdc: usd(amountUsd), submittedBlock: a.blockNumber, submittedAt: a.timestamp,
      status, tokensFilled: filled, currencyRefunded: filled == null ? null : 0n, updatedBlock: a.blockNumber, updatedAt: a.timestamp,
    });
  };

  if (!whole) {
    activities.push(act("shard", PAOLO, auctioning ? 14 * 60 : 7 * 86_400, 3n * S, { totalShards: 16, forSale: 3, auction: AUCTION, shardToken: TOKEN }, SHARD_AT.b));
    tr(ZERO, PAOLO, 13n * S, auctioning ? 14 * 60 : 7 * 86_400);
    tr(ZERO, AUCTION, 3n * S, auctioning ? 14 * 60 : 7 * 86_400);
    if (auctioning) {
      bid(AIKO, 816, 1640, 9 * 60, "open", null);
      bid(X7A3, 1712, 1712, 4 * 60, "open", null);
      bid(KENJI, 2550, 1700, 2 * 60, "open", null);
    } else {
      bid(KENJI, 3424, 1760, 2 * 3600, "claimed", 2n * S);
      bid(X7A3, 1712, 1800, 41 * 60, "claimed", 1n * S);
      activities.push(act("settle", KENJI, 22 * 60, usd(5136), { graduated: true, shardToken: TOKEN, clearingUsdcPerShard: usd(1712).toString() }));
      activities.push(act("exit", KENJI, 22 * 60, 0n, { auction: AUCTION, bidId: "1", tokensFilled: (2n * S).toString() }));
      activities.push(act("claim", KENJI, 22 * 60, 2n * S, { auction: AUCTION, bidId: "1" }));
      tr(AUCTION, KENJI, 2n * S, 22 * 60);
      activities.push(act("exit", X7A3, 21 * 60, 0n, { auction: AUCTION, bidId: "2", tokensFilled: (1n * S).toString() }));
      activities.push(act("claim", X7A3, 21 * 60, 1n * S, { auction: AUCTION, bidId: "2" }));
      tr(AUCTION, X7A3, 1n * S, 21 * 60);
      tr(KENJI, AIKO, S / 2n, 8 * 60);
    }
  }
  if (released) {
    activities.push(act("redeem", PAOLO, 90 * 60, usd(5136), { buyoutPerShard: usd(1712).toString(), fee: usd(128.4).toString(), shardToken: TOKEN }));
    activities.push(act("payout", KENJI, 80 * 60, usd(2568), { shardUnits: (3n * S / 2n).toString(), shardToken: TOKEN }));
    activities.push(act("release", PAOLO, 60 * 60, null, null));
  }
  activities.sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1));

  // Balances: every holder of the current token, the auction included (it holds unclaimed shards).
  const bal = (holder: Hex, units: bigint): BalanceRow => ({ id: `${TOKEN}-${holder}`.toLowerCase(), shardToken: TOKEN, holder, balance: units, updatedBlock: HEAD, updatedAt: at(60) });
  const holders: BalanceRow[] = whole || released ? []
    : auctioning ? [bal(PAOLO, 13n * S), bal(AUCTION, 3n * S)]
    : [bal(PAOLO, 13n * S), bal(KENJI, 3n * S / 2n), bal(X7A3, 1n * S), bal(AIKO, S / 2n), bal(AUCTION, 0n)].filter((h) => h.balance > 0n);
  const supply = holders.reduce((a, h) => a + h.balance, 0n);

  const rec = (key: string, value: string, secondsAgo: number): EnsRecordRow => ({
    node: NODE, key, value, setBy: addresses.vendor as Hex, resolver: addresses.ensResolver as Hex, updatedBlock: blockAgo(secondsAgo), updatedAt: at(secondsAgo),
  });
  const vaultState = card.state;
  const ensRecords: EnsRecordRow[] = [
    rec("condition", "NM", 3 * 3600),
    rec("language", "en", 7 * 86_400 + 600),
    rec("vault.state", vaultState, 60),
    ...(whole || auctioning ? [] : [rec("vault.clearing_usdc", "1712000000", 22 * 60)]),
    rec("appraisal.usd", "25000.00", 2 * 86_400),
    rec("avatar", "https://cards.scryfall.io/normal/front/b/0/b0faa7f2-b547-42c4-a810-839da50dadfe.jpg", 7 * 86_400 + 600),
    rec("description", "Black Lotus, Limited Edition Alpha", 7 * 86_400 + 600),
    rec("scryfall", card.scryfallId, 7 * 86_400 + 600),
    rec("url", "https://kuravault.xyz/app/cards/1", 7 * 86_400 + 600),
  ];

  const checkpoints: CheckpointRow[] = auctioning
    ? [1560, 1600, 1640, 1712].map((p, i) => ({ id: `${AUCTION}-${startBlock + BigInt(i)}`, auction: AUCTION, blockNumber: startBlock + BigInt(i * 10), clearingPriceQ96: usdcPerShardToQ96(usd(p)), cumulativeMps: BigInt(i) * 1000n, timestamp: at(14 * 60 - i * 120) }))
    : [];

  // Auction ticks: the clearing price and USDC raised so far, one per block with activity.
  const ticks: TickRow[] = auctioning
    ? [[1560, 816], [1640, 2528], [1712, 5078], [1712, 6848]].map(([p, raised], i) => ({
      id: `${AUCTION}-${startBlock + BigInt(i * 10)}`, auction: AUCTION, cardId: 1n, blockNumber: startBlock + BigInt(i * 10), timestamp: at(14 * 60 - i * 180),
      clearingPriceQ96: usdcPerShardToQ96(usd(p!)), clearingUsdcPerShard: usd(p!), currencyRaised: usd(raised!), totalCleared: 0n,
    }))
    : [];

  return {
    card,
    sharding: whole ? null : sharding,
    allShardings: whole ? [] : [sharding],
    meta: {
      name: "Black Lotus (LEA) #1",
      description: "Black Lotus, Limited Edition Alpha #232, NM, held in the Kura vault.",
      image: "https://cards.scryfall.io/png/front/b/0/b0faa7f2-b547-42c4-a810-839da50dadfe.png",
      external_url: "https://kuravault.xyz/app/cards/1",
      attributes: [{ trait_type: "Set", value: "LEA" }, { trait_type: "Rarity", value: "rare" }],
    },
    attributes: { set: "lea", setName: "Limited Edition Alpha", rarity: "rare", colors: [], lang: "en", usd: "25000.00", artist: "Christopher Rush" },
    price: { usd: "25000.00", source: { finish: "nonfoil", lang: "en", printingId: card.scryfallId, englishFallback: false }, conditionMultiplier: 1, adjustedUsd: "25000" },
    holders,
    supply,
    myBalance: holders.find((h) => h.holder === PAOLO)?.balance ?? 0n,
    activities: state === "empty" ? [] : activities,
    transfers,
    bids,
    ticks,
    checkpoints,
    ensNode: NODE,
    ensName: {
      label: card.label, labelHash: hash(0x1abe1), kind: "card", node: NODE, tokenId: 1n, owner: addresses.cardNames as Hex,
      resolver: addresses.ensResolver as Hex, cardId: 1n, expiry: null, registeredAt: MINT.ts, revokedAt: released ? at(60 * 60) : null, updatedBlock: HEAD, updatedAt: at(60),
    },
    ensRecords: state === "empty" ? [] : ensRecords,
    isLoading: state === "loading",
  };
}

export const FIXTURE_HEAD = HEAD;
