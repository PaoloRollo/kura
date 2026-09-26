// Demo rehearsal and seeding. Drives five real cards through every path of the vault (buyout, graduated auction,
// reserve not met, physical release, whole) with synthetic `seed…` wallets, printing each tx and asserting the result.
//
//   pnpm rehearse                 print the plan (wallets, cards, amounts, USDC and ETH budget) and exit
//   pnpm rehearse --dry-run       run the whole scenario on a local anvil fork of Sepolia; nothing is broadcast
//   pnpm rehearse --broadcast     run it on Sepolia (asks you to type BROADCAST; refuses without a TTY or in CI)
//   --live-blocks N               duration of the re-sharded live auction (default 7200 blocks, about a day)
//
// Broadcast runs are resumable: scripts/.rehearse-state.sepolia.json records every step and its tx hash. A rerun skips
// finished steps, and a step with a hash but no receipt is waited for, never sent again.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  toHex,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { generateMnemonic, english, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  APPRAISAL_TYPES,
  DeploymentsSchema,
  TICKET_TYPES,
  TicketKind,
  abi,
  bidGateDomain,
  cardVaultDomain,
  q96ToUsdcPerShard,
  setCode,
  slugify,
  usdcPerShardToQ96,
  type Deployments,
  type Ticket,
} from "@kura/shared";
import { exitRoute, type ExitCheckpoint } from "../apps/web/src/lib/bid-math";
import { finishOf, marketPerShard, quoteMarketPrice, quoteUsdc, type PrintingPrices } from "../apps/web/src/lib/pricing";
import { encodeHookData } from "../apps/web/src/lib/tx-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHARD = 10n ** 18n;
const USDC = 10n ** 6n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// ---------------------------------------------------------------------------------------------------------------------
// Scenario (pure)

export type CardKey = "A" | "B" | "C" | "D" | "E";
export type Role = "owner0" | "owner1" | "bidder0" | "bidder1" | "bidder2" | "bidder3";
export const ROLES: readonly Role[] = ["owner0", "owner1", "bidder0", "bidder1", "bidder2", "bidder3"];
/** Collector handles (a-z0-9 only: CardNames refuses dashes, so "seed" is a prefix, not "seed-"). */
export const HANDLES: Record<Role, string> = {
  owner0: "seedaiko", owner1: "seedkenji", bidder0: "seedmei", bidder1: "seedren", bidder2: "seedsora", bidder3: "seedyuki",
};

/** Cheap real printings (Scryfall USD in the $0.25–$3 band when chosen); every price is re-read and re-quoted live. */
export const CARDS: Record<CardKey, { scryfallId: string; owner: Role; role: string }> = {
  A: { scryfallId: "9521375e-0bc1-45ef-b513-6d332a25f9d2", owner: "owner0", role: "buyout, then re-sharded as the live auction" }, // Lightning Bolt, 4ED
  B: { scryfallId: "cca8eb95-d071-46a4-885c-3da25b401806", owner: "owner1", role: "graduated auction, stays sharded" }, // Counterspell, A25
  C: { scryfallId: "5fa7af70-08d0-453f-a0b6-a408642bf03e", owner: "owner0", role: "reserve not met, all bids refunded" }, // Llanowar Elves, BTD
  D: { scryfallId: "6739a5bb-5ed7-4f15-affb-4170239d997a", owner: "owner1", role: "released at the counter (Passport ticket)" }, // Dark Ritual, SUM
  E: { scryfallId: "b635680a-12ae-49f8-a3d7-7254cb0962ec", owner: "owner0", role: "stays whole: station and owner fallback" }, // Swords to Plowshares, MB2
};

export const TOTAL_SHARDS = 16;
export const TICK_USDC = 10_000n; // 0.01 USDC per shard
export const MIN_FLOOR_USDC = 50_000n; // 0.05 USDC per shard
export const BID_TTL_SEC = 3600n; // HUMAN tickets: short-lived on purpose
export const PASSPORT_TTL_SEC = 900n;
export const APPRAISAL_TTL_SEC = 600n;
export const ENDED_AUCTION_BLOCKS = { A: 25, B: 30, C: 30 } as const;
export const DEFAULT_LIVE_BLOCKS = 7200;

/** A bid: `ticks` above the floor, budget = `shardsX10 / 10` shards at that max. */
export type BidPlan = { bidder: Role; ticks: number; shardsX10: number };
export type AuctionPlan = {
  forSale: number;
  floorUsdc: bigint;
  reserveUsdc: bigint;
  durationBlocks: number;
  /** In submission order: lowest max first, so each bid meets the floor as the clearing price. */
  bids: BidPlan[];
};

export const AUCTION_SHAPES: Record<"A" | "B" | "C" | "A2", Omit<AuctionPlan, "floorUsdc" | "durationBlocks">> = {
  // 3 of 16 for sale: the owner keeps 13/16 = 81.25%, above the 80% redemption rule.
  A: { forSale: 3, reserveUsdc: 0n, bids: [{ bidder: "bidder2", ticks: 1, shardsX10: 10 }, { bidder: "bidder1", ticks: 2, shardsX10: 10 }, { bidder: "bidder0", ticks: 3, shardsX10: 12 }] },
  // 8 of 16, four bidders at different maxes: demand above supply, so the clearing climbs and the lowest bid is outbid.
  B: { forSale: 8, reserveUsdc: 0n, bids: [{ bidder: "bidder3", ticks: 1, shardsX10: 10 }, { bidder: "bidder2", ticks: 2, shardsX10: 15 }, { bidder: "bidder1", ticks: 3, shardsX10: 20 }, { bidder: "bidder0", ticks: 4, shardsX10: 30 }] },
  // Reserve far above the bids: the auction does not graduate and both bids are refunded in full.
  C: { forSale: 4, reserveUsdc: 5n * USDC, bids: [{ bidder: "bidder3", ticks: 1, shardsX10: 10 }, { bidder: "bidder2", ticks: 2, shardsX10: 10 }] },
  // The live auction for the demo, with one pre-seeded bid (the fallback if World ID fails on stage).
  A2: { forSale: 4, reserveUsdc: 0n, bids: [{ bidder: "bidder3", ticks: 2, shardsX10: 10 }] },
};

export const floorToTick = (usdc: bigint, tick: bigint) => (usdc / tick) * tick;
export const tickQ96 = (tickUsdc: bigint) => usdcPerShardToQ96(tickUsdc);
/** The auction floor in Q96, as CardVault._auctionParams builds it (an exact tick multiple). */
export const floorQ96 = (floorUsdc: bigint, tickUsdc: bigint) => tickQ96(tickUsdc) * (floorUsdc / tickUsdc);
export const bidMaxQ96 = (floorUsdc: bigint, tickUsdc: bigint, ticks: number) => floorQ96(floorUsdc, tickUsdc) + BigInt(ticks) * tickQ96(tickUsdc);
/** USDC a bid spends at most: its shards at its max price. */
export const bidBudget = (floorUsdc: bigint, tickUsdc: bigint, b: BidPlan) => (q96ToUsdcPerShard(bidMaxQ96(floorUsdc, tickUsdc, b.ticks)) * BigInt(b.shardsX10)) / 10n;

/** Floor per shard: the market price per shard rounded down to a tick, at least MIN_FLOOR_USDC. */
export const floorFor = (marketUsdc: bigint) => {
  const f = floorToTick(marketUsdc / BigInt(TOTAL_SHARDS), TICK_USDC);
  return f < MIN_FLOOR_USDC ? MIN_FLOOR_USDC : f;
};

export type ScenarioPlan = {
  markets: Record<CardKey, string>; // USDC units (condition-adjusted, lib/pricing), as strings for the state file
  auctions: Record<"A" | "B" | "C" | "A2", AuctionPlan>;
  liveBlocks: number;
};

export function planScenario(markets: Record<CardKey, bigint>, liveBlocks: number): ScenarioPlan {
  const auction = (key: "A" | "B" | "C" | "A2", card: CardKey, durationBlocks: number): AuctionPlan => ({ ...AUCTION_SHAPES[key], floorUsdc: floorFor(markets[card]), durationBlocks });
  return {
    markets: Object.fromEntries(Object.entries(markets).map(([k, v]) => [k, v.toString()])) as Record<CardKey, string>,
    auctions: { A: auction("A", "A", ENDED_AUCTION_BLOCKS.A), B: auction("B", "B", ENDED_AUCTION_BLOCKS.B), C: auction("C", "C", ENDED_AUCTION_BLOCKS.C), A2: auction("A2", "A", liveBlocks) },
    liveBlocks,
  };
}

export type Budget = { perRole: Record<Role, bigint>; totalUsdc: bigint; buyoutUsdc: bigint; ethTarget: Record<Role | "vendor", bigint> };

/**
 * USDC each seed wallet must hold before the run. Bids count at their full budget (refunds and payouts come back only
 * later); the buyout is bounded by the card A shards for sale at max(highest A bid, appraisal) plus the vault fee.
 */
export function budget(plan: ScenarioPlan, feeBps: bigint): Budget {
  const perRole = Object.fromEntries(ROLES.map((r) => [r, 0n])) as Record<Role, bigint>;
  for (const a of Object.values(plan.auctions)) for (const b of a.bids) perRole[b.bidder] += bidBudget(a.floorUsdc, TICK_USDC, b);
  const A = plan.auctions.A;
  const topBid = A.bids.reduce((m, b) => (b.ticks > m ? b.ticks : m), 0);
  const topBidUsdc = q96ToUsdcPerShard(bidMaxQ96(A.floorUsdc, TICK_USDC, topBid));
  const appraisal = BigInt(plan.markets.A) / BigInt(TOTAL_SHARDS);
  const price = topBidUsdc > appraisal ? topBidUsdc : appraisal;
  const payout = price * BigInt(A.forSale);
  const buyoutUsdc = payout + (payout * feeBps) / 10_000n + 1n;
  perRole[CARDS.A.owner] += buyoutUsdc;
  const totalUsdc = Object.values(perRole).reduce((a, b) => a + b, 0n);
  return {
    perRole,
    totalUsdc,
    buyoutUsdc,
    ethTarget: { owner0: parseEther("0.03"), owner1: parseEther("0.02"), bidder0: parseEther("0.01"), bidder1: parseEther("0.01"), bidder2: parseEther("0.01"), bidder3: parseEther("0.01"), vendor: parseEther("0.02") },
  };
}

/** Top-up needed to bring `have` to `target`, or 0 when `have` is at least half of it (the threshold). */
export const ethTopUp = (have: bigint, target: bigint) => (have * 2n >= target ? 0n : target - have);
export const usdcTopUp = (have: bigint, need: bigint) => (have >= need ? 0n : need - have);

export function faucetMessage(deployer: Address, need: bigint, have: bigint): string | null {
  if (have >= need) return null;
  return `Top up ${deployer} at https://faucet.circle.com (Ethereum Sepolia, USDC). Need ${formatUnits(need, 6)}, have ${formatUnits(have, 6)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tickets (pure)

/** A synthetic World ID nullifier for a seed wallet: nothing real is bound. */
export const seedNullifier = (address: Address) => BigInt(keccak256(toHex(`kura:seed:${address.toLowerCase()}`)));

export function humanTicket(subject: Address, nowSec: bigint, ttl = BID_TTL_SEC): Ticket {
  return { kind: TicketKind.HUMAN, subject, nullifier: seedNullifier(subject), expiresAt: nowSec + ttl };
}

export function passportTicket(holder: Address, nowSec: bigint, ttl = PASSPORT_TTL_SEC): Ticket {
  // Single use: CardVault marks the digest used, so the time in the nullifier keeps a rerun from colliding.
  return { kind: TicketKind.PASSPORT, subject: holder, nullifier: BigInt(keccak256(toHex(`kura:seed:passport:${holder.toLowerCase()}:${nowSec}`))), expiresAt: nowSec + ttl };
}

// ---------------------------------------------------------------------------------------------------------------------
// Modes and the broadcast guard (pure)

export type Mode = "plan" | "dry-run" | "broadcast";
export function parseArgs(argv: readonly string[]): { mode: Mode; liveBlocks: number } {
  const dry = argv.includes("--dry-run");
  const live = argv.includes("--broadcast");
  if (dry && live) throw new Error("pick one of --dry-run and --broadcast");
  const i = argv.indexOf("--live-blocks");
  const liveBlocks = i >= 0 ? Number(argv[i + 1]) : DEFAULT_LIVE_BLOCKS;
  if (!Number.isInteger(liveBlocks) || liveBlocks < 2 || liveBlocks > 1_000_000) throw new Error("--live-blocks must be an integer in 2..1000000");
  return { mode: dry ? "dry-run" : live ? "broadcast" : "plan", liveBlocks };
}

/** Why a broadcast must not start here, or null. Only an interactive terminal outside CI may broadcast. */
export function broadcastRefusal(env: { isTTY: boolean | undefined; ci: string | undefined }): string | null {
  if (env.ci && env.ci !== "false" && env.ci !== "0") return "refusing to broadcast in CI";
  if (!env.isTTY) return "refusing to broadcast without an interactive terminal (stdin is not a TTY)";
  return null;
}

export const isBroadcastConfirmation = (answer: string) => answer.trim() === "BROADCAST";

// ---------------------------------------------------------------------------------------------------------------------
// Resumable steps (pure logic, injected chain calls)

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
/** `failed`: the last send reverted (hashes kept for the record); the step runs afresh next time. */
export type StepRecord = { status: "sent" | "done" | "skipped" | "failed"; hash?: Hex; out?: Json; failed?: Hex[] };
export type RehearseState = { version: 1; network: string; wallets?: Record<string, Address>; plan?: ScenarioPlan; steps: Record<string, StepRecord> };

export const newState = (network: string): RehearseState => ({ version: 1, network, steps: {} });

export type ReceiptLike = { status: "success" | "reverted"; blockNumber: bigint; transactionHash: Hex };
export type StepIO<R extends ReceiptLike> = {
  /** Returns a value when the step's effect is already on chain (no tx needed), else undefined. */
  skip?: () => Promise<Json | undefined>;
  send: () => Promise<Hex>;
  wait: (hash: Hex) => Promise<R>;
  parse?: (receipt: R) => Json;
  save: (state: RehearseState) => void;
};

/** A step already sent or finished: it must not be prepared (or sent) again. */
export const isStarted = (rec: StepRecord | undefined) => rec?.status === "done" || rec?.status === "skipped" || rec?.status === "sent";

/**
 * Runs one step at most once. Done or skipped: returns the recorded output. Sent (a hash, no receipt yet): waits for
 * that receipt and never sends again, the same rule as the web tx layer. New: checks `skip`, sends, records the hash
 * before waiting. A reverted receipt clears the step (a revert can't land later), so a rerun sends it afresh.
 */
export async function runStep<R extends ReceiptLike>(state: RehearseState, id: string, io: StepIO<R>): Promise<{ out: Json; hash?: Hex; fresh: boolean; receipt?: R }> {
  const rec = state.steps[id];
  if (rec && (rec.status === "done" || rec.status === "skipped")) return { out: rec.out ?? null, hash: rec.hash, fresh: false };
  let hash = rec?.status === "sent" ? rec.hash : undefined;
  if (!hash) {
    if (io.skip) {
      const already = await io.skip();
      if (already !== undefined) {
        state.steps[id] = { status: "skipped", out: already, failed: rec?.failed };
        io.save(state);
        return { out: already, fresh: false };
      }
    }
    hash = await io.send();
    state.steps[id] = { status: "sent", hash, failed: rec?.failed };
    io.save(state);
  }
  const receipt = await io.wait(hash);
  if (receipt.status !== "success") {
    state.steps[id] = { status: "failed", failed: [...(rec?.failed ?? []), hash] };
    io.save(state);
    throw new Error(`step ${id} reverted in ${hash}`);
  }
  const out = io.parse ? io.parse(receipt) : null;
  state.steps[id] = { status: "done", hash, out, failed: rec?.failed };
  io.save(state);
  return { out, hash, fresh: true, receipt };
}

const BIG = "$big:";
export const encodeState = (s: RehearseState) => JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? `${BIG}${v}` : v), 2) + "\n";
export const decodeState = (text: string): RehearseState =>
  JSON.parse(text, (_k, v) => (typeof v === "string" && v.startsWith(BIG) ? BigInt(v.slice(BIG.length)) : v)) as RehearseState;

// ---------------------------------------------------------------------------------------------------------------------
// Runtime

type Wallet = { role: Role | "vendor" | "deployer"; account: Account; address: Address };
type Ctx = {
  mode: Exclude<Mode, "plan">;
  network: "fork" | "sepolia";
  pub: PublicClient;
  rpcUrl: string;
  d: Deployments;
  state: RehearseState;
  statePath: string;
  deployer: Wallet;
  vendor: Wallet;
  signer: PrivateKeyAccount;
  seeds: Record<Role, Wallet>;
  log: { id: string; hash?: Hex; note?: string }[];
  fees: bigint;
  gas: Map<string, bigint>;
  /** Some steps were finished by an earlier run: run-wide balance deltas can't be asserted. */
  resumed: boolean;
};

function loadDotEnv() {
  const file = join(ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file); // never overrides variables already set in the shell
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

function loadDeployments(): Deployments {
  return DeploymentsSchema.parse(JSON.parse(readFileSync(join(ROOT, "contracts/deployments/sepolia.json"), "utf8")));
}

const txUrl = (network: string, hash: Hex) => (network === "sepolia" ? `https://sepolia.etherscan.io/tx/${hash}` : `${hash} (fork)`);
const usd = (v: bigint) => {
  const [whole, frac = ""] = formatUnits(v, 6).split(".");
  return `$${whole}.${frac.padEnd(2, "0")}`;
};

async function scryfallCard(id: string): Promise<PrintingPrices & { name: string; set_name: string; finishes: string[]; image_uris?: { png?: string; normal?: string }; card_faces?: { image_uris?: { png?: string; normal?: string } }[] }> {
  const res = await fetch(`https://api.scryfall.com/cards/${id}`, { headers: { "User-Agent": "kura-rehearse/1.0", Accept: "application/json" } });
  if (!res.ok) throw new Error(`Scryfall ${id}: HTTP ${res.status}`);
  await new Promise((r) => setTimeout(r, 120)); // Scryfall asks for 50–100 ms between requests
  return res.json();
}

type CardInfo = { key: CardKey; scryfallId: string; name: string; setName: string; slug: string; setCode: string; lang: string; imageUrl: string; description: string; marketUsdc: bigint };

async function loadCards(): Promise<Record<CardKey, CardInfo>> {
  const out = {} as Record<CardKey, CardInfo>;
  for (const key of Object.keys(CARDS) as CardKey[]) {
    const c = await scryfallCard(CARDS[key].scryfallId);
    const description = `${c.name}, ${c.set_name}`; // the scan station's mint description (no ", foil": non-foil printings)
    const quote = await quoteMarketPrice({
      printing: c,
      finish: finishOf(description, c),
      condition: "NM",
      englishPrinting: async (set, num) => scryfallCard(`${set}/${num}`).catch(() => null),
    });
    const market = quoteUsdc(quote);
    if (!market) throw new Error(`card ${key} (${c.name}, ${c.set}) has no Scryfall USD price; pick another printing`);
    const img = c.image_uris ?? c.card_faces?.find((f) => f.image_uris)?.image_uris ?? {};
    out[key] = { key, scryfallId: c.id, name: c.name, setName: c.set_name, slug: slugify(c.name), setCode: setCode(c.set), lang: c.lang, imageUrl: img.png ?? img.normal ?? "", description, marketUsdc: market };
  }
  return out;
}

function seedWallets(mnemonic: string): Record<Role, Wallet> {
  return Object.fromEntries(ROLES.map((role, i): [Role, Wallet] => {
    const account = mnemonicToAccount(mnemonic, { addressIndex: i });
    return [role, { role, account, address: account.address }];
  })) as unknown as Record<Role, Wallet>;
}

function printPlan(cards: Record<CardKey, CardInfo>, plan: ScenarioPlan, b: Budget, seeds: Record<Role, Wallet> | null, feeBps: bigint) {
  console.log("\nWallets (SEED_MNEMONIC, addressIndex 0..5)");
  for (const r of ROLES) console.log(`  ${r.padEnd(8)} ${HANDLES[r]}.kura.eth  ${seeds ? seeds[r].address : "(set SEED_MNEMONIC)"}  USDC ${usd(b.perRole[r])}  ETH ≥ ${formatEther(b.ethTarget[r] / 2n)} (top up to ${formatEther(b.ethTarget[r])})`);
  console.log("\nCards (condition NM, priced with apps/web/src/lib/pricing.ts)");
  for (const k of Object.keys(cards) as CardKey[]) {
    const c = cards[k];
    console.log(`  ${k}  ${c.name} (${c.setCode.toUpperCase()}) ${c.scryfallId}  market ${usd(c.marketUsdc)}  → ${CARDS[k].owner}  ${CARDS[k].role}`);
  }
  console.log("\nAuctions (16 shards, tick $0.01)");
  for (const [k, a] of Object.entries(plan.auctions)) {
    const bids = a.bids.map((x) => `${x.bidder} ${x.shardsX10 / 10} @ ${usd(q96ToUsdcPerShard(bidMaxQ96(a.floorUsdc, TICK_USDC, x.ticks)))} = ${usd(bidBudget(a.floorUsdc, TICK_USDC, x))}`).join("; ");
    console.log(`  ${k.padEnd(2)} forSale ${a.forSale}, floor ${usd(a.floorUsdc)}, reserve ${usd(a.reserveUsdc)}, ${a.durationBlocks} blocks. Bids: ${bids}`);
  }
  console.log(`\nBudget: ${usd(b.totalUsdc)} USDC in total from the deployer (buyout of A ≤ ${usd(b.buyoutUsdc)} incl. the ${Number(feeBps) / 100}% fee).`);
  const eth = Object.values(b.ethTarget).reduce((x, y) => x + y, 0n);
  console.log(`ETH: at most ${formatEther(eth)} Sepolia ETH of top-ups (seed wallets and the vendor, each only when below half its target).`);
}

// --- chain helpers ---------------------------------------------------------------------------------------------------

function saveState(ctx: Ctx) {
  writeFileSync(ctx.statePath, encodeState(ctx.state));
}

async function step(ctx: Ctx, id: string, from: Wallet, call: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint }, opts: { skip?: () => Promise<Json | undefined>; parse?: (r: TransactionReceipt) => Json; note?: string } = {}) {
  const wallet = createWalletClient({ account: from.account, chain: sepolia, transport: http(ctx.rpcUrl) });
  const res = await runStep<TransactionReceipt>(ctx.state, id, {
    skip: opts.skip,
    send: async () => {
      const { request } = await ctx.pub.simulateContract({ ...call, account: from.account } as never);
      return wallet.writeContract(request as never);
    },
    wait: (hash) => ctx.pub.waitForTransactionReceipt({ hash, timeout: 10 * 60_000, pollingInterval: ctx.network === "fork" ? 200 : 4_000 }),
    parse: opts.parse,
    save: () => saveState(ctx),
  });
  if (!res.fresh && ctx.state.steps[id]?.status === "done") ctx.resumed = true;
  if (res.receipt) ctx.gas.set(from.role, (ctx.gas.get(from.role) ?? 0n) + res.receipt.gasUsed * res.receipt.effectiveGasPrice);
  ctx.log.push({ id, hash: res.hash, note: res.fresh ? opts.note : `${opts.note ?? ""} (${ctx.state.steps[id]?.status === "skipped" ? "already on chain" : "resumed"})`.trim() });
  console.log(`  ${res.fresh ? "✓" : "·"} ${id.padEnd(26)} ${res.hash ? txUrl(ctx.network, res.hash) : "skipped: already on chain"}${opts.note ? `  ${opts.note}` : ""}`);
  return res;
}

const events = (r: TransactionReceipt, a: Abi, eventName: string) => parseEventLogs({ abi: a, logs: r.logs, eventName } as never) as unknown as { args: Record<string, unknown>; address: Address }[];

async function chainNow(ctx: Ctx): Promise<bigint> {
  return (await ctx.pub.getBlock()).timestamp;
}

const read = <T>(ctx: Ctx, address: Address, a: Abi, functionName: string, args: readonly unknown[] = []) => ctx.pub.readContract({ address, abi: a, functionName, args } as never) as Promise<T>;
const usdcOf = (ctx: Ctx, who: Address) => read<bigint>(ctx, ctx.d.usdc, abi.erc20, "balanceOf", [who]);
const shardsOf = (ctx: Ctx, token: Address, who: Address) => read<bigint>(ctx, token, abi.shardToken, "balanceOf", [who]);

type CardOnChain = { state: number; beneficialOwner: Address; shardToken: Address; auction: Address; endBlock: bigint };
const cardOf = (ctx: Ctx, id: bigint) => read<CardOnChain>(ctx, ctx.d.cardVault, abi.cardVault, "cards", [id]);
type ShardingOnChain = { graduated: boolean; settled: boolean; clearingPriceQ96: bigint; buyoutPerShard: bigint; redeemer: Address };
const shardingOf = (ctx: Ctx, token: Address) => read<ShardingOnChain>(ctx, ctx.d.cardVault, abi.cardVault, "shardings", [token]);
const STATE = ["None", "Whole", "Auctioning", "Sharded", "Released"];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// --- scenario steps --------------------------------------------------------------------------------------------------

/** ETH and USDC top-ups: each computed from the live balance at send time, skipped when the wallet already has enough. */
async function fundWallets(ctx: Ctx, b: Budget) {
  console.log("\nFunding (from the deployer)");
  const targets: Wallet[] = [...ROLES.map((r) => ctx.seeds[r]), ctx.vendor];
  const wallet = createWalletClient({ account: ctx.deployer.account, chain: sepolia, transport: http(ctx.rpcUrl) });
  const wait = (hash: Hex) => ctx.pub.waitForTransactionReceipt({ hash, timeout: 10 * 60_000, pollingInterval: ctx.network === "fork" ? 200 : 4_000 });
  for (const w of targets) {
    const target = b.ethTarget[w.role as Role | "vendor"];
    const id = `eth-${w.role}`;
    let topUp = 0n;
    const res = await runStep<TransactionReceipt>(ctx.state, id, {
      skip: async () => {
        topUp = ethTopUp(await ctx.pub.getBalance({ address: w.address }), target);
        return topUp === 0n ? "enough" : undefined;
      },
      send: () => wallet.sendTransaction({ to: w.address, value: topUp }),
      wait,
      save: () => saveState(ctx),
    });
    ctx.log.push({ id, hash: res.hash });
    console.log(`  ${res.fresh ? "✓" : "·"} ${id.padEnd(26)} ${res.hash ? txUrl(ctx.network, res.hash) : "skipped: enough ETH"}${res.fresh ? `  +${formatEther(topUp)} ETH` : ""}`);
  }
  for (const r of ROLES) {
    const want = b.perRole[r];
    if (want === 0n) continue;
    let topUp = 0n;
    const id = `usdc-${r}`;
    const res = await runStep<TransactionReceipt>(ctx.state, id, {
      skip: async () => {
        topUp = usdcTopUp(await usdcOf(ctx, ctx.seeds[r].address), want);
        return topUp === 0n ? "enough" : undefined;
      },
      send: () => wallet.writeContract({ address: ctx.d.usdc, abi: abi.erc20, functionName: "transfer", args: [ctx.seeds[r].address, topUp] }),
      wait,
      save: () => saveState(ctx),
    });
    ctx.log.push({ id, hash: res.hash });
    console.log(`  ${res.fresh ? "✓" : "·"} ${id.padEnd(26)} ${res.hash ? txUrl(ctx.network, res.hash) : "skipped: enough USDC"}${res.fresh ? `  +${usd(topUp)}` : ""}`);
  }
}

async function registerHandles(ctx: Ctx) {
  console.log("\nCollector handles");
  for (const r of ROLES) {
    const w = ctx.seeds[r];
    const label = HANDLES[r];
    await step(ctx, `handle-${r}`, w, { address: ctx.d.cardNames, abi: abi.cardNames, functionName: "registerCollector", args: [label] }, {
      note: `${label}.kura.eth`,
      skip: async () => {
        const mine = await read<string>(ctx, ctx.d.cardNames, abi.cardNames, "collectorLabels", [w.address]);
        if (mine) return mine;
        if (!(await read<boolean>(ctx, ctx.d.cardNames, abi.cardNames, "isAvailable", [label]))) throw new Error(`${label}.kura.eth is taken by another wallet; change HANDLES in scripts/rehearse.ts`);
        return undefined;
      },
    });
  }
}

async function approvePermit2(ctx: Ctx, plan: ScenarioPlan) {
  console.log("\nUSDC → Permit2 approvals (bidders, once)");
  const bidders = new Set(Object.values(plan.auctions).flatMap((a) => a.bids.map((b) => b.bidder)));
  for (const r of bidders) {
    const w = ctx.seeds[r];
    await step(ctx, `permit2-${r}`, w, { address: ctx.d.usdc, abi: abi.erc20, functionName: "approve", args: [ctx.d.permit2, 2n ** 256n - 1n] }, {
      skip: async () => ((await read<bigint>(ctx, ctx.d.usdc, abi.erc20, "allowance", [w.address, ctx.d.permit2])) >= 10n ** 30n ? "approved" : undefined),
    });
  }
}

async function mintCards(ctx: Ctx, cards: Record<CardKey, CardInfo>): Promise<Record<CardKey, bigint>> {
  console.log("\nMint (vendor → owners)");
  const ids = {} as Record<CardKey, bigint>;
  for (const k of Object.keys(CARDS) as CardKey[]) {
    const c = cards[k];
    const to = ctx.seeds[CARDS[k].owner].address;
    const res = await step(ctx, `mint-${k}`, ctx.vendor, {
      address: ctx.d.cardVault, abi: abi.cardVault, functionName: "mint",
      args: [{ to, scryfallId: c.scryfallId, slug: c.slug, setCode: c.setCode, condition: "NM", language: c.lang, imageUrl: c.imageUrl, description: c.description }],
    }, { parse: (r) => String(events(r, abi.cardVault, "CardMinted")[0].args.id), note: `${c.name} → ${HANDLES[CARDS[k].owner]}` });
    ids[k] = BigInt(res.out as string);
  }
  for (const k of Object.keys(ids) as CardKey[]) console.log(`  card ${k} = #${ids[k]} (${cards[k].slug}-${cards[k].setCode}-${ids[k]}.kura.eth)`);
  return ids;
}

type Sharded = { token: Address; auction: Address; startBlock: bigint; endBlock: bigint };

async function shard(ctx: Ctx, key: string, cardId: bigint, owner: Wallet, a: AuctionPlan): Promise<Sharded> {
  const res = await step(ctx, `shard-${key}`, owner, {
    address: ctx.d.cardVault, abi: abi.cardVault, functionName: "shardAndAuction",
    args: [cardId, { totalShards: TOTAL_SHARDS, forSale: a.forSale, floorUsdcPerShard: a.floorUsdc, tickUsdcPerShard: TICK_USDC, reserveUsdc: a.reserveUsdc, durationBlocks: a.durationBlocks }],
  }, {
    note: `${a.forSale}/16 for sale, ${a.durationBlocks} blocks`,
    parse: (r) => {
      const e = events(r, abi.cardVault, "CardSharded")[0].args;
      return { token: e.shardToken as string, auction: e.auction as string, startBlock: String(e.startBlock), endBlock: String(e.endBlock) };
    },
  });
  const o = res.out as Record<string, string>;
  return { token: o.token as Address, auction: o.auction as Address, startBlock: BigInt(o.startBlock), endBlock: BigInt(o.endBlock) };
}

type PlacedBid = { key: string; bidder: Role; bidId: bigint; maxQ96: bigint; amount: bigint; block: bigint };

async function placeBids(ctx: Ctx, key: string, s: Sharded, a: AuctionPlan): Promise<PlacedBid[]> {
  const placed: PlacedBid[] = [];
  const tick = tickQ96(TICK_USDC);
  for (const b of a.bids) {
    const w = ctx.seeds[b.bidder];
    const amount = bidBudget(a.floorUsdc, TICK_USDC, b);
    await step(ctx, `p2-${key}-${b.bidder}`, w, { address: ctx.d.permit2, abi: abi.permit2, functionName: "approve", args: [ctx.d.usdc, s.auction, amount, Number((await chainNow(ctx)) + 30n * 24n * 3600n)] }, {
      skip: async () => {
        const [allowed, expiration] = await read<readonly [bigint, number, number]>(ctx, ctx.d.permit2, abi.permit2, "allowance", [w.address, ctx.d.usdc, s.auction]);
        return allowed >= amount && BigInt(expiration) > (await chainNow(ctx)) ? "approved" : undefined;
      },
    });
    const ticket = humanTicket(w.address, await chainNow(ctx));
    const sig = await ctx.signer.signTypedData({ domain: bidGateDomain(ctx.d.bidGateHook), types: TICKET_TYPES, primaryType: "Ticket", message: ticket });
    const hookData = encodeHookData(ticket, sig);
    // A bid must sit above the clearing price at its block; if demand already moved it, step the max up a tick at a time.
    let maxQ96 = bidMaxQ96(a.floorUsdc, TICK_USDC, b.ticks);
    if (!isStarted(ctx.state.steps[`bid-${key}-${b.bidder}`])) {
      for (let i = 0; i < 6; i++) {
        try {
          await ctx.pub.simulateContract({ address: s.auction, abi: abi.ccaAuction, functionName: "submitBid", args: [maxQ96, amount, w.address, hookData], account: w.account });
          break;
        } catch (e) {
          if (!String(e).includes("BidMustBeAboveClearingPrice") || i === 5) throw e;
          maxQ96 += tick;
        }
      }
    }
    const res = await step(ctx, `bid-${key}-${b.bidder}`, w, { address: s.auction, abi: abi.ccaAuction, functionName: "submitBid", args: [maxQ96, amount, w.address, hookData] }, {
      note: `${HANDLES[b.bidder]} ${usd(amount)} up to ${usd(q96ToUsdcPerShard(maxQ96))}/shard`,
      parse: (r) => {
        const e = events(r, abi.ccaAuction, "BidSubmitted")[0].args;
        return { bidId: String(e.id), maxQ96: String(e.priceQ96), block: String(r.blockNumber) };
      },
    });
    const o = res.out as Record<string, string>;
    placed.push({ key, bidder: b.bidder, bidId: BigInt(o.bidId), maxQ96: BigInt(o.maxQ96), amount, block: BigInt(o.block) });
  }
  return placed;
}

async function waitForBlock(ctx: Ctx, target: bigint) {
  const now = await ctx.pub.getBlockNumber();
  if (now >= target) return;
  if (ctx.network === "fork") {
    await ctx.pub.request({ method: "anvil_mine" as never, params: [toHex(target - now)] as never });
    console.log(`  mined ${target - now} blocks on the fork (anvil_mine) to block ${target}`);
    return;
  }
  console.log(`  waiting for block ${target} (now ${now}, about ${Number(target - now) * 12}s)`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 12_000));
    const b = await ctx.pub.getBlockNumber();
    if (b >= target) return;
    process.stdout.write(`    block ${b}, ${target - b} to go\n`);
  }
}

type Settled = { graduated: boolean; clearingQ96: bigint; raised: bigint; fee: bigint };

async function settle(ctx: Ctx, key: string, cardId: bigint, from: Wallet): Promise<Settled> {
  const res = await step(ctx, `settle-${key}`, from, { address: ctx.d.cardVault, abi: abi.cardVault, functionName: "settle", args: [cardId] }, {
    parse: (r) => {
      const e = events(r, abi.cardVault, "AuctionSettled")[0].args;
      return { graduated: e.graduated as boolean, clearingQ96: String(e.clearingPriceQ96), raised: String(e.raisedUsdc), fee: String(e.feeUsdc) };
    },
  });
  const o = res.out as Record<string, string | boolean>;
  const s = { graduated: o.graduated as boolean, clearingQ96: BigInt(o.clearingQ96 as string), raised: BigInt(o.raised as string), fee: BigInt(o.fee as string) };
  console.log(`    ${key}: ${s.graduated ? "graduated" : "not graduated"}, clearing ${usd(q96ToUsdcPerShard(s.clearingQ96))}/shard, raised ${usd(s.raised)}, fee ${usd(s.fee)}`);
  return s;
}

async function checkpoints(ctx: Ctx, s: Sharded): Promise<ExitCheckpoint[]> {
  const logs = await ctx.pub.getContractEvents({ address: s.auction, abi: abi.ccaAuction, eventName: "CheckpointUpdated", fromBlock: s.startBlock, toBlock: "latest" } as never);
  return (logs as unknown as { args: { blockNumber: bigint; clearingPriceQ96: bigint } }[]).map((l) => ({ blockNumber: l.args.blockNumber, clearingPriceQ96: l.args.clearingPriceQ96 }));
}

/** Exit every bid through the web's exitRoute, then claim the filled ones. Returns each exit's fill and refund. */
async function exitAndClaim(ctx: Ctx, key: string, s: Sharded, settled: Settled, bids: PlacedBid[]) {
  const cps = await checkpoints(ctx, s);
  const exits: { bid: PlacedBid; tokens: bigint; refund: bigint; fresh: boolean }[] = [];
  for (const b of bids) {
    const w = ctx.seeds[b.bidder];
    const route = exitRoute({ bidId: b.bidId, maxPriceQ96: b.maxQ96, submittedBlock: b.block }, settled.graduated, cps, settled.clearingQ96);
    if (!route) throw new Error(`no fully filled checkpoint for bid ${b.bidId} on ${key}`);
    const res = await step(ctx, `exit-${key}-${b.bidder}`, w, { address: s.auction, abi: abi.ccaAuction, functionName: route.fn, args: route.args }, {
      note: route.fn,
      skip: async () => {
        const bid = await read<{ exitedBlock: bigint; tokensFilled: bigint }>(ctx, s.auction, abi.ccaAuction, "bids", [b.bidId]);
        return bid.exitedBlock !== 0n ? { tokensFilled: String(bid.tokensFilled), refund: "0" } : undefined;
      },
      parse: (r) => {
        const e = events(r, abi.ccaAuction, "BidExited")[0].args;
        return { tokensFilled: String(e.tokensFilled), refund: String(e.currencyRefunded) };
      },
    });
    const o = res.out as Record<string, string>;
    const tokens = BigInt(o.tokensFilled);
    if (res.fresh) console.log(`    bid ${b.bidId} (${HANDLES[b.bidder]}): ${formatUnits(tokens, 18)} shards filled, refund ${usd(BigInt(o.refund))}`);
    exits.push({ bid: b, tokens, refund: BigInt(o.refund), fresh: res.fresh });
    if (settled.graduated && tokens > 0n) {
      // claimTokens needs the exit first, and after the claim block (= the end block here).
      await step(ctx, `claim-${key}-${b.bidder}`, w, { address: s.auction, abi: abi.ccaAuction, functionName: "claimTokens", args: [b.bidId] }, {
        skip: async () => ((await read<{ tokensFilled: bigint }>(ctx, s.auction, abi.ccaAuction, "bids", [b.bidId])).tokensFilled === 0n ? "claimed" : undefined),
      });
    }
  }
  return exits;
}

async function redeemA(ctx: Ctx, cardId: bigint, s: Sharded, owner: Wallet, plan: ScenarioPlan) {
  console.log("\nCard A: buyout");
  const [supply, bal, feeBps, sh] = await Promise.all([
    read<bigint>(ctx, s.token, abi.shardToken, "totalSupply"),
    shardsOf(ctx, s.token, owner.address),
    read<number>(ctx, ctx.d.cardVault, abi.cardVault, "feeBps").then(BigInt),
    shardingOf(ctx, s.token),
  ]);
  // The redeem rule (apps/web/src/lib/buyout.ts): price = max(clearing, appraisal); payout for supply − balance; fee on top.
  const appraisal = marketPerShard(BigInt(plan.markets.A), TOTAL_SHARDS) ?? 0n;
  const clearing = q96ToUsdcPerShard(sh.clearingPriceQ96);
  const price = appraisal > clearing ? appraisal : clearing;
  const missing = supply - bal;
  const payout = (price * missing) / SHARD;
  const fee = (payout * feeBps) / 10_000n;
  console.log(`    owner holds ${formatUnits(bal, 18)}/${formatUnits(supply, 18)}; price max(${usd(clearing)}, appraisal ${usd(appraisal)}) = ${usd(price)}; payout ${usd(payout)} + fee ${usd(fee)}`);
  if (!ctx.state.steps["redeem-A"]) assert(bal * 5n >= supply * 4n, "the owner of A holds at least 80% of the shards");
  await step(ctx, "approve-redeem-A", owner, { address: ctx.d.usdc, abi: abi.erc20, functionName: "approve", args: [ctx.d.cardVault, payout + fee] }, {
    skip: async () => ((await read<bigint>(ctx, ctx.d.usdc, abi.erc20, "allowance", [owner.address, ctx.d.cardVault])) >= payout + fee || ctx.state.steps["redeem-A"] ? "approved" : undefined),
  });
  const appr = { cardId, shardToken: s.token, usdcPerShard: appraisal, expiresAt: (await chainNow(ctx)) + APPRAISAL_TTL_SEC };
  const sig = await ctx.signer.signTypedData({ domain: cardVaultDomain(ctx.d.cardVault), types: APPRAISAL_TYPES, primaryType: "Appraisal", message: appr });
  const res = await step(ctx, "redeem-A", owner, { address: ctx.d.cardVault, abi: abi.cardVault, functionName: "redeem", args: [cardId, appr, sig] }, {
    parse: (r) => {
      const e = events(r, abi.cardVault, "CardRedeemed")[0].args;
      return { price: String(e.buyoutPerShard), payout: String(e.payoutUsdc), fee: String(e.feeUsdc) };
    },
  });
  const o = res.out as Record<string, string>;
  ctx.fees += BigInt(o.fee);
  if (res.fresh) assert(BigInt(o.payout) === payout && BigInt(o.fee) === fee, `redeem charged exactly the quoted ${usd(payout)} + ${usd(fee)}`);
  const holder = await read<Address>(ctx, ctx.d.cardVault, abi.cardVault, "ownerOf", [cardId]);
  const card = await cardOf(ctx, cardId);
  if (!ctx.state.steps["shard-A2"]) {
    assert(holder.toLowerCase() === owner.address.toLowerCase() && card.state === 1, "after the buyout the redeemer holds card A's NFT and it is Whole");
    assert((await read<bigint>(ctx, ctx.d.usdc, abi.erc20, "allowance", [owner.address, ctx.d.cardVault])) === 0n, "the buyout used the exact USDC approval");
  }
  return { price: BigInt(o.price) };
}

async function claimPayouts(ctx: Ctx, s: Sharded, price: bigint, holders: Role[]) {
  console.log("\nCard A: minority payouts");
  for (const r of holders) {
    const w = ctx.seeds[r];
    const bal = await shardsOf(ctx, s.token, w.address);
    const before = await usdcOf(ctx, w.address);
    const res = await step(ctx, `payout-A-${r}`, w, { address: ctx.d.cardVault, abi: abi.cardVault, functionName: "claimPayout", args: [s.token] }, {
      skip: async () => (bal === 0n ? "nothing to claim" : undefined),
      parse: (rc) => String(events(rc, abi.cardVault, "PayoutClaimed")[0].args.usdc),
    });
    if (res.fresh) {
      const paid = BigInt(res.out as string);
      assert(paid === (price * bal) / SHARD && (await usdcOf(ctx, w.address)) - before === paid, `${HANDLES[r]} received ${usd(paid)} for ${formatUnits(bal, 18)} shards`);
    }
  }
}

async function indexerChecks(ctx: Ctx, ids: Record<CardKey, bigint>, tokenC: Address) {
  const url = process.env.PONDER_URL ?? process.env.NEXT_PUBLIC_PONDER_URL;
  if (!url) return console.log("  (PONDER_URL not set: indexer checks skipped)");
  const { createClient, inArray, eq } = await import("@ponder/client");
  const schema = await import("../apps/indexer/ponder.schema");
  const client = createClient(`${url.replace(/\/$/, "")}/sql`, { schema });
  // The schema's drizzle and @ponder/client's are separate copies: same runtime shape, different types (cf. lib/ponder-bridge).
  const t = <T>(x: unknown) => x as T;
  const want: Record<CardKey, string> = { A: "auctioning", B: "sharded", C: "sharded", D: "released", E: "whole" };
  for (let i = 0; i < 30; i++) {
    const rows = (await client.db.select().from(t<never>(schema.cards)).where(inArray(t<never>(schema.cards.id), Object.values(ids)))) as { id: bigint; state: string }[];
    const [c] = (await client.db.select().from(t<never>(schema.shardings)).where(eq(t<never>(schema.shardings.shardToken), tokenC))) as { graduated: boolean | null }[];
    const ok = (Object.keys(want) as CardKey[]).every((k) => rows.find((r) => r.id === ids[k])?.state === want[k]) && c?.graduated === false;
    if (ok) {
      assert(true, "indexer: A auctioning, B sharded, C sharded, D released, E whole");
      assert(c.graduated === false, "indexer: shardings.graduated === false for card C");
      return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error("indexer did not reach the expected card states within 150 s");
}

function writeManifest(ctx: Ctx, cards: Record<CardKey, CardInfo>, ids: Record<CardKey, bigint>, sh: Record<string, Sharded>) {
  const dir = join(ROOT, "scripts/seed");
  mkdirSync(dir, { recursive: true });
  const manifest = {
    seed: true,
    network: "sepolia",
    chainId: 11155111,
    generatedAt: new Date().toISOString(),
    wallets: Object.fromEntries(ROLES.map((r) => [r, { address: ctx.seeds[r].address, handle: `${HANDLES[r]}.kura.eth` }])),
    cards: Object.fromEntries((Object.keys(ids) as CardKey[]).map((k) => [k, { id: ids[k].toString(), scryfallId: cards[k].scryfallId, name: cards[k].name, label: `${cards[k].slug}-${cards[k].setCode}-${ids[k]}`, owner: CARDS[k].owner, role: CARDS[k].role }])),
    shardings: Object.fromEntries(Object.entries(sh).map(([k, s]) => [k, { shardToken: s.token, auction: s.auction, startBlock: s.startBlock.toString(), endBlock: s.endBlock.toString() }])),
    txs: Object.fromEntries(Object.entries(ctx.state.steps).filter(([, s]) => s.hash).map(([id, s]) => [id, s.hash])),
  };
  writeFileSync(join(dir, "sepolia.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nManifest written: scripts/seed/sepolia.json`);
}

// --- anvil -----------------------------------------------------------------------------------------------------------

/**
 * Fork only: set `who`'s USDC balance. anvil_dealERC20 can't find Circle's slot (FiatToken keeps balances in a mapping
 * whose top bit is the blacklist flag), so probe the mapping slots with anvil_setStorageAt, keeping the one that works.
 */
async function forkDealUsdc(ctx: Ctx, who: Address, amount: bigint) {
  for (let slot = 0n; slot < 32n; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, slot]));
    const old = await ctx.pub.getStorageAt({ address: ctx.d.usdc, slot: key });
    await ctx.pub.request({ method: "anvil_setStorageAt" as never, params: [ctx.d.usdc, key, toHex(amount, { size: 32 })] as never });
    if ((await usdcOf(ctx, who)) === amount) return;
    await ctx.pub.request({ method: "anvil_setStorageAt" as never, params: [ctx.d.usdc, key, old ?? toHex(0n, { size: 32 })] as never });
  }
  throw new Error("could not find the USDC balance slot on the fork");
}

async function startAnvil(forkUrl: string, port: number): Promise<ChildProcess> {
  const child = spawn("nice", ["-n", "10", "anvil", "--fork-url", forkUrl, "--port", String(port), "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr?.on("data", (d) => (err += String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited: ${err}`);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill("SIGTERM");
  throw new Error("anvil did not start within 30 s");
}

// --- main ------------------------------------------------------------------------------------------------------------

async function main() {
  loadDotEnv();
  const { mode, liveBlocks } = parseArgs(process.argv.slice(2));
  const d = loadDeployments();
  const rpc = process.env.ALCHEMY_HTTP_URL ?? process.env.SEPOLIA_RPC_URL;

  if (mode === "broadcast") {
    const refusal = broadcastRefusal({ isTTY: process.stdin.isTTY, ci: process.env.CI });
    if (refusal) {
      console.error(refusal);
      process.exit(2);
    }
  }

  console.log("Loading cards from Scryfall…");
  const cards = await loadCards();
  const markets = Object.fromEntries((Object.keys(cards) as CardKey[]).map((k) => [k, cards[k].marketUsdc])) as Record<CardKey, bigint>;
  const network = mode === "broadcast" ? "sepolia" : "fork";
  const statePath = join(ROOT, `scripts/.rehearse-state.${network}.json`);

  if (mode === "plan") {
    const feeBps = rpc ? BigInt(await createPublicClient({ chain: sepolia, transport: http(rpc) }).readContract({ address: d.cardVault, abi: abi.cardVault, functionName: "feeBps" })) : 250n;
    const plan = planScenario(markets, liveBlocks);
    const b = budget(plan, feeBps);
    const mnemonic = process.env.SEED_MNEMONIC;
    printPlan(cards, plan, b, mnemonic ? seedWallets(mnemonic) : null, feeBps);
    if (rpc && process.env.DEPLOYER_PRIVATE_KEY) {
      const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex).address;
      const have = await createPublicClient({ chain: sepolia, transport: http(rpc) }).readContract({ address: d.usdc, abi: abi.erc20, functionName: "balanceOf", args: [deployer] });
      console.log(faucetMessage(deployer, b.totalUsdc, have) ?? `Deployer ${deployer} holds ${usd(have)} USDC: enough.`);
    }
    if (!mnemonic) console.log("SEED_MNEMONIC is not set: --dry-run uses a throwaway mnemonic; --broadcast requires it.");
    console.log("\nPlan only: nothing was sent. Run with --dry-run (fork) or --broadcast (Sepolia).");
    return;
  }

  if (!rpc) throw new Error("ALCHEMY_HTTP_URL (or SEPOLIA_RPC_URL) is not set");
  const signer = privateKeyToAccount(need("SIGNER_PRIVATE_KEY") as Hex);
  if (signer.address.toLowerCase() !== d.signer.toLowerCase()) throw new Error(`SIGNER_PRIVATE_KEY is for ${signer.address}, but the contracts trust ${d.signer}`);
  console.log(`✓ signer ${signer.address} is the deployment's signer`);
  const vendorAcc = privateKeyToAccount(need("VENDOR_PRIVATE_KEY") as Hex);
  if (vendorAcc.address.toLowerCase() !== d.vendor.toLowerCase()) throw new Error(`VENDOR_PRIVATE_KEY is for ${vendorAcc.address}, but the vault's vendor is ${d.vendor}`);
  const deployerAcc = privateKeyToAccount(need("DEPLOYER_PRIVATE_KEY") as Hex);

  let mnemonic = process.env.SEED_MNEMONIC;
  if (!mnemonic) {
    if (mode === "broadcast") throw new Error("SEED_MNEMONIC is not set: the seed wallets must be recoverable after a broadcast");
    mnemonic = generateMnemonic(english);
    console.log("SEED_MNEMONIC is not set: using a throwaway mnemonic for this fork run.");
  }

  let anvil: ChildProcess | null = null;
  const cleanup = () => {
    if (anvil && anvil.exitCode === null) anvil.kill("SIGTERM");
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  let rpcUrl = rpc;
  if (mode === "dry-run") {
    console.log("Starting anvil (nice -n 10) on :8546, forking Sepolia…");
    anvil = await startAnvil(rpc, 8546);
    rpcUrl = "http://127.0.0.1:8546";
    rmSync(statePath, { force: true }); // a fork is fresh every run, so its state is too
  }
  const pub = createPublicClient({ chain: sepolia, transport: http(rpcUrl) }) as PublicClient;
  if ((await pub.getChainId()) !== 11155111) throw new Error("the RPC is not Sepolia (chain id 11155111)");

  const state = existsSync(statePath) ? decodeState(readFileSync(statePath, "utf8")) : newState(network);
  const seeds = seedWallets(mnemonic);
  const wallets = Object.fromEntries(ROLES.map((r) => [r, seeds[r].address]));
  if (state.wallets && JSON.stringify(state.wallets) !== JSON.stringify(wallets)) throw new Error(`${statePath} was written for other seed wallets (a different SEED_MNEMONIC)`);
  state.wallets = wallets;
  const feeBps = BigInt(await pub.readContract({ address: d.cardVault, abi: abi.cardVault, functionName: "feeBps" }));
  state.plan ??= planScenario(markets, liveBlocks); // a resumed run keeps the prices and bids it started with
  const plan = state.plan;
  const b = budget(plan, feeBps);

  const ctx: Ctx = {
    mode, network, pub, rpcUrl, d, state, statePath, signer,
    deployer: { role: "deployer", account: deployerAcc, address: deployerAcc.address },
    vendor: { role: "vendor", account: vendorAcc, address: vendorAcc.address },
    seeds, log: [], fees: 0n, gas: new Map(), resumed: false,
  };
  saveState(ctx);
  printPlan(cards, plan, b, seeds, feeBps);

  for (const r of ROLES) {
    const code = await pub.getCode({ address: seeds[r].address });
    if (code && code !== "0x") throw new Error(`${r} ${seeds[r].address} has code (an EIP-7702 delegation?); it could not receive its ENS handle`);
  }

  if (mode === "broadcast") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nThis sends real transactions on Sepolia from ${deployerAcc.address}, the vendor and six seed wallets.\nType BROADCAST to continue: `);
    rl.close();
    if (!isBroadcastConfirmation(answer)) {
      console.log("Not confirmed; nothing was sent.");
      return;
    }
  }

  // Deployer USDC: stop with the faucet link when short. On the fork the shortfall is dealt locally so the run goes on.
  // What the seed wallets still lack (a resumed run may have funded some already).
  let stillNeeded = 0n;
  for (const r of ROLES) stillNeeded += usdcTopUp(await usdcOf(ctx, seeds[r].address), b.perRole[r]);
  const have = await usdcOf(ctx, deployerAcc.address);
  const short = faucetMessage(deployerAcc.address, stillNeeded, have);
  if (short) {
    if (mode === "broadcast") throw new Error(short);
    console.log(`\n! ${short}\n  (fork only: dealing the shortfall to the deployer with anvil_dealERC20)`);
    await forkDealUsdc(ctx, deployerAcc.address, have + stillNeeded);
  }
  const payoutAddr = await read<Address>(ctx, d.cardVault, abi.cardVault, "payout");
  const payoutBefore = await usdcOf(ctx, payoutAddr);

  await fundWallets(ctx, b);
  await registerHandles(ctx);
  await approvePermit2(ctx, plan);
  const ids = await mintCards(ctx, cards);

  console.log("\nAuctions A, B, C: shard and bid");
  const sA = await shard(ctx, "A", ids.A, seeds[CARDS.A.owner], plan.auctions.A);
  const bidsA = await placeBids(ctx, "A", sA, plan.auctions.A);
  const sB = await shard(ctx, "B", ids.B, seeds[CARDS.B.owner], plan.auctions.B);
  const bidsB = await placeBids(ctx, "B", sB, plan.auctions.B);
  const sC = await shard(ctx, "C", ids.C, seeds[CARDS.C.owner], plan.auctions.C);
  const bidsC = await placeBids(ctx, "C", sC, plan.auctions.C);

  console.log("\nSettle");
  await waitForBlock(ctx, sA.endBlock);
  const setA = await settle(ctx, "A", ids.A, seeds[CARDS.A.owner]);
  await waitForBlock(ctx, sB.endBlock);
  const setB = await settle(ctx, "B", ids.B, seeds[CARDS.B.owner]);
  await waitForBlock(ctx, sC.endBlock);
  const setC = await settle(ctx, "C", ids.C, seeds[CARDS.C.owner]);
  for (const s of [setA, setB, setC]) ctx.fees += s.fee;

  console.log("\nExit and claim");
  await exitAndClaim(ctx, "A", sA, setA, bidsA);
  await exitAndClaim(ctx, "B", sB, setB, bidsB);
  const exitsC = await exitAndClaim(ctx, "C", sC, setC, bidsC);

  const { price } = await redeemA(ctx, ids.A, sA, seeds[CARDS.A.owner], plan);
  await claimPayouts(ctx, sA, price, [...new Set(bidsA.map((x) => x.bidder))]);

  console.log("\nCard B: a holder sends 0.5 shards");
  await step(ctx, "send-B", seeds[CARDS.B.owner], { address: sB.token, abi: abi.shardToken, functionName: "transfer", args: [seeds.bidder0.address, SHARD / 2n] }, { note: `${HANDLES[CARDS.B.owner]} → ${HANDLES.bidder0}` });

  console.log("\nCard D: release at the counter");
  const holderD = await read<Address>(ctx, d.cardVault, abi.cardVault, "ownerOf", [ids.D]);
  const pass = passportTicket(holderD, await chainNow(ctx));
  const passSig = await signer.signTypedData({ domain: cardVaultDomain(d.cardVault), types: TICKET_TYPES, primaryType: "Ticket", message: pass });
  await step(ctx, "release-D", ctx.vendor, { address: d.cardVault, abi: abi.cardVault, functionName: "confirmRelease", args: [ids.D, pass, passSig] }, {
    note: `Passport ticket for ${HANDLES[CARDS.D.owner]}`,
    skip: async () => ((await cardOf(ctx, ids.D)).state === 4 ? "released" : undefined),
  });

  console.log(`\nCard A: re-shard as the live auction (${plan.liveBlocks} blocks)`);
  const sA2 = await shard(ctx, "A2", ids.A, seeds[CARDS.A.owner], plan.auctions.A2);
  await placeBids(ctx, "A2", sA2, plan.auctions.A2);

  console.log("\nAssertions (on chain)");
  const st = async (k: CardKey) => (await cardOf(ctx, ids[k])).state;
  assert((await st("A")) === 2, "card A is Auctioning (re-sharded, live)");
  assert((await st("B")) === 3 && setB.graduated, "card B is Sharded after a graduated auction");
  const shC = await shardingOf(ctx, sC.token);
  assert((await st("C")) === 3 && shC.settled && shC.graduated === false, "card C is Sharded and its auction did not graduate");
  assert((await shardsOf(ctx, sC.token, seeds[CARDS.C.owner].address)) === BigInt(TOTAL_SHARDS) * SHARD, "card C's owner holds all 16 shards again");
  for (const x of exitsC.filter((e) => e.fresh)) {
    assert(x.tokens === 0n && x.refund === x.bid.amount, `${HANDLES[x.bid.bidder]} got the card C bid (${usd(x.bid.amount)}) back in full`);
  }
  assert((await st("D")) === 4, "card D is Released");
  assert((await st("E")) === 1, "card E is Whole");
  assert((await shardsOf(ctx, sB.token, seeds.bidder0.address)) >= SHARD / 2n, `${HANDLES.bidder0} holds the 0.5 shards sent on card B`);
  const feesPaid = (await usdcOf(ctx, payoutAddr)) - payoutBefore;
  if (ctx.resumed) console.log("  (resumed run: the fee total is checked on a fresh run only)");
  else assert(feesPaid === ctx.fees, `vault fees ${usd(ctx.fees)} (settle + buyout events) reached the payout address`);

  if (mode === "broadcast") {
    console.log("\nAssertions (indexer)");
    await indexerChecks(ctx, ids, sC.token);
    writeManifest(ctx, cards, ids, { A: sA, B: sB, C: sC, A2: sA2 });
  }

  console.log("\nSummary");
  console.log(`  ${"step".padEnd(26)} tx`);
  for (const l of ctx.log) console.log(`  ${l.id.padEnd(26)} ${l.hash ? txUrl(network, l.hash) : "-"}`);
  const gas = [...ctx.gas.entries()].map(([r, v]) => `${r} ${formatEther(v)}`).join(", ");
  console.log(`\nGas spent (ETH): ${gas}`);
  console.log(`Cards: ${(Object.keys(ids) as CardKey[]).map((k) => `${k}=#${ids[k]}`).join(" ")}  live auction ${sA2.auction}`);
  if (mode === "dry-run") console.log("\nDRY RUN (fork) — nothing was broadcast");
  else console.log(`\nBROADCAST complete. State: ${statePath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
