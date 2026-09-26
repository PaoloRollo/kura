"use client";

import { CountdownHead } from "@/components/countdown";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CircleDollarSignIcon, GlobeIcon } from "lucide-react";
import { encodeAbiParameters, encodeEventTopics, type TransactionReceipt } from "viem";
import { abi, usdcPerShardToQ96 } from "@kura/shared";
import { AuctionIoContext, type AuctionIo, type GateProps, type ReadRequest } from "@/components/auction-io";
import { BarChip, Button, EnsName, TopBar } from "@/components/kura";
import { CardPageView } from "@/components/card-page-view";
import { NAV } from "@/components/site-header";
import type { IssuedTicket } from "@/components/world-id-gate";
import { showOwnerSettled } from "@/components/settle-success";
import type { BidRow, CardData, CheckpointRow } from "@/hooks/use-card";
import { addresses } from "@/lib/chain";
import { HandlesFixture } from "@/hooks/use-handles";
import type { CardTab } from "@/lib/card-view";
import { TxError, type SendInput, type Sent } from "@/lib/tx-core";
import { cn } from "@/lib/utils";
import { FIXTURE_HEAD, HANDLES, PAOLO, cardFixture, marketFixture } from "../card/fixtures";
import { AUCTION_PREVIEWS, ENDED_STATES, type AuctionPreviewState } from "./states";

const usd = (dollars: number) => BigInt(Math.round(dollars * 100)) * 10_000n;
const BOUND_TO = "0x9b1d5c0e7a3f2b4c6d8e0f1a2b3c4d5e6f7a84e7";
const fakeHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

/** A preview "send": waits like a block, then succeeds, or fails with the state's revert. Nothing reaches a wallet. */
function fakeSend(state: AuctionPreviewState) {
  let n = 0;
  return async (input: SendInput): Promise<Sent> => {
    await new Promise((r) => setTimeout(r, 900));
    n += 1;
    if (input.functionName === "submitBid") {
      if (state === "expired") throw new TxError("preview", { name: "ValidationHookCallFailed", inner: { name: "Expired", args: [] } });
      if (state === "price-moved") throw new TxError("preview", { name: "BidMustBeAboveClearingPrice" });
    }
    const hash = fakeHash(0x71c02 + n);
    const logs = input.functionName === "settle" ? [settledLog(state !== "ended-reserve")] : [];
    return { hash, receipt: { status: "success", blockNumber: 1n, logs, transactionHash: hash } as unknown as TransactionReceipt, gas: "sponsored" };
  };
}

/** AuctionSettled for card 1, as the vault emits it: $5,136 raised, 2.5% fee (or nothing, reserve not met). */
function settledLog(graduated: boolean) {
  const raised = graduated ? usd(5136) : 0n;
  const fee = graduated ? usd(128.4) : 0n;
  return {
    address: addresses.cardVault,
    topics: encodeEventTopics({ abi: abi.cardVault, eventName: "AuctionSettled", args: { id: 1n, shardToken: "0x0000000000000000000000000000000000005a1d" } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }], [usdcPerShardToQ96(usd(1712)), raised, fee, graduated]),
  };
}

/** Chain reads for the fixture auction: nothing approved yet, $5,000 of USDC. */
function fakeRead(clearingQ96: bigint, state: AuctionPreviewState) {
  const reserve = state === "ended-reserve" || state === "settled-reserve";
  return async <T,>(req: ReadRequest): Promise<T> => {
    const v: Record<string, unknown> = {
      clearingPrice: clearingQ96,
      currencyRaised: reserve ? usd(1240) : usd(ENDED_STATES.includes(state) ? 5136 : 6848),
      totalCleared: reserve ? 0n : 3n * 10n ** 18n,
      isGraduated: !reserve,
      balanceOf: usd(5000),
      allowance: req.args?.length === 3 ? [0n, 0, 0] : 0n,
      cards: { state: 2 },
      bids: { exitedBlock: 0n, tokensFilled: 0n },
    };
    return v[req.functionName] as T;
  };
}

function ticketFor(now: number): IssuedTicket {
  return { ticket: { kind: 1, subject: PAOLO, nullifier: "123456789", expiresAt: String(now + 86_400) }, signature: "0x00", credential: "orb" };
}

/**
 * After the end block: paolo's two bids, #4 ($2,000 up to $1,760: filled, or a full refund due) and #5 ($1,640 up to
 * $1,640: outbid, already exited with nothing filled). Settled states carry the vault's AuctionSettled numbers.
 */
function endedFixture(state: AuctionPreviewState, c: CardData): CardData {
  const s = c.sharding!;
  const settled = state === "settled" || state === "settled-reserve";
  const reserve = state === "ended-reserve" || state === "settled-reserve";
  const q = (d: number) => usdcPerShardToQ96(usd(d));
  const mk = (bidId: bigint, amount: number, max: number, status: BidRow["status"], filled: bigint | null, refunded: bigint | null): BidRow => ({
    id: `${s.auction}-${bidId}`, auction: s.auction, bidId, cardId: 1n, shardToken: s.shardToken, owner: PAOLO, maxPriceQ96: q(max), amountUsdc: usd(amount),
    submittedBlock: s.startBlock + 8n, submittedAt: 0, status, tokensFilled: filled, currencyRefunded: refunded, updatedBlock: s.endBlock, updatedAt: 0,
  });
  const mine = state === "no-bids" ? [] : [mk(4n, 2000, 1760, "open", null, null), mk(5n, 1640, 1640, "exited", 0n, usd(1640))];
  const others = c.bids.filter((b) => b.owner !== PAOLO);
  return {
    ...c,
    card: { ...c.card!, state: settled ? "sharded" : "auctioning" },
    sharding: {
      ...s,
      settled,
      graduated: settled ? !reserve : null,
      clearingUsdcPerShard: settled && !reserve ? usd(1712) : null,
      raisedUsdc: settled ? (reserve ? 0n : usd(5136)) : null,
      feeUsdc: settled ? (reserve ? 0n : usd(128.4)) : null,
    },
    bids: [...mine, ...others],
  };
}

export function AuctionPreview({ state, tab, now }: { state: AuctionPreviewState; tab: CardTab; now: number }) {
  const base = cardFixture("auctioning", now);
  const s = base.sharding!;
  // Sixteen checkpoints from the floor up to the current $1,712, for the chart.
  const prices = [1560, 1560, 1560, 1580, 1580, 1600, 1600, 1620, 1640, 1640, 1660, 1680, 1680, 1700, 1700, 1712];
  const checkpoints: CheckpointRow[] = prices.map((p, i) => ({
    id: `${s.auction}-${s.startBlock + BigInt(i * 4)}`, auction: s.auction, blockNumber: s.startBlock + BigInt(i * 4),
    clearingPriceQ96: usdcPerShardToQ96(usd(p)), cumulativeMps: BigInt(i) * 1000n, timestamp: now - 14 * 60 + i * 48,
  }));
  const clearingQ96 = checkpoints.at(-1)!.clearingPriceQ96;
  const ended = ENDED_STATES.includes(state);
  const c: CardData = ended ? endedFixture(state, { ...base, checkpoints }) : { ...base, checkpoints };
  const block = ended ? s.endBlock + 5n : FIXTURE_HEAD;
  // Oh2m9: the seller has just settled (the success replaces the card page until "See Black Lotus").
  useEffect(() => {
    if (state !== "owner-settled") return;
    showOwnerSettled({ cardId: 1n, hash: fakeHash(0x71c02), raisedUsdc: usd(5136), feeUsdc: usd(128.4), graduated: true, clearingQ96, sold: 3 });
    return () => showOwnerSettled(null);
  }, [state, clearingQ96]);

  const [ticket, setTicket] = useState<IssuedTicket | null>(state === "unverified" || state === "refused" ? null : ticketFor(now));
  const io = useMemo<Partial<AuctionIo>>(() => {
    function StubGate({ onTicket, onError }: GateProps) {
      // p5hrR: the server refuses this World ID as soon as the preview opens.
      const fired = useRef(false);
      useEffect(() => {
        if (state !== "refused" || fired.current) return;
        fired.current = true;
        onError("ALREADY_BOUND", { boundTo: BOUND_TO });
      }, [onError]);
      return (
        <Button
          variant="inverse"
          size="md"
          className="h-11 w-full rounded-xl text-[15px]"
          onClick={() => {
            if (state === "refused") return onError("ALREADY_BOUND", { boundTo: BOUND_TO });
            const t = ticketFor(now);
            setTicket(t);
            onTicket(t);
          }}
        >
          <GlobeIcon aria-hidden />Verify with World ID
        </Button>
      );
    }
    return {
      send: fakeSend(state),
      read: fakeRead(clearingQ96, state),
      walletKind: "embedded",
      switchWallet: () => {},
      Gate: StubGate,
      formDefaults: state === "invalid" ? { budget: "9,000.00", max: "1,705.00" } : state === "unverified" || state === "refused" ? {} : { budget: "2,000.00" },
    };
  }, [state, now, clearingQ96]);

  const href = (t: CardTab) => `/design/auction?state=${state}${t === "overview" ? "" : `&tab=${t}`}`;
  return (
    <HandlesFixture.Provider value={HANDLES}>
      <CountdownHead.Provider value={{ number: block, timestamp: now }}>
      <AuctionIoContext.Provider value={{ ...io, ticket }}>
        <div className="min-h-screen">
          <TopBar
            className="max-md:hidden"
            homeHref="/app"
            nav={NAV.collector}
            pathname="/app"
            exactHrefs={["/app"]}
            right={
              <>
                <BarChip icon={CircleDollarSignIcon} className="hidden sm:inline-flex">5,000.00 USDC</BarChip>
                <span className="inline-flex h-9 items-center rounded-md border border-border px-3"><EnsName name="paolo.kura.eth" copyable={false} /></span>
              </>
            }
          />
          <nav aria-label="Preview states" data-preview-nav className="flex flex-wrap gap-2 border-b border-border px-4 py-2 lg:px-12">
            {AUCTION_PREVIEWS.map((p) => (
              <Link key={p} href={`/design/auction?state=${p}${tab === "overview" ? "" : `&tab=${tab}`}`} className={cn("rounded-full px-2.5 py-1 text-[12px]", p === state ? "bg-surface-2 text-text" : "text-muted-foreground")}>{p}</Link>
            ))}
          </nav>
          <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">
            <CardPageView key={state} c={c} me={PAOLO} now={now} block={block} tab={tab} tabHref={href} market={marketFixture(now)} />
          </main>
        </div>
      </AuctionIoContext.Provider>
      </CountdownHead.Provider>
    </HandlesFixture.Provider>
  );
}
