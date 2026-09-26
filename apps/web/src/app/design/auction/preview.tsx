"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CircleDollarSignIcon, GlobeIcon } from "lucide-react";
import type { TransactionReceipt } from "viem";
import { usdcPerShardToQ96 } from "@kura/shared";
import { AuctionIoContext, type AuctionIo, type GateProps, type ReadRequest } from "@/components/auction-io";
import { BarChip, Button, EnsName, TopBar } from "@/components/kura";
import { CardPageView } from "@/components/card-page-view";
import { NAV } from "@/components/site-header";
import type { IssuedTicket } from "@/components/world-id-gate";
import type { CheckpointRow } from "@/hooks/use-card";
import { HandlesFixture } from "@/hooks/use-handles";
import type { CardTab } from "@/lib/card-view";
import { TxError, type SendInput, type Sent } from "@/lib/tx-core";
import { cn } from "@/lib/utils";
import { FIXTURE_HEAD, HANDLES, PAOLO, cardFixture } from "../card/fixtures";
import { AUCTION_PREVIEWS, type AuctionPreviewState } from "./states";

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
    return { hash: fakeHash(0x71c02 + n), receipt: { status: "success", blockNumber: 1n, logs: [] } as unknown as TransactionReceipt, gas: "sponsored" };
  };
}

/** Chain reads for the fixture auction: nothing approved yet, $5,000 of USDC. */
function fakeRead(clearingQ96: bigint) {
  return async <T,>(req: ReadRequest): Promise<T> => {
    const v: Record<string, unknown> = {
      clearingPrice: clearingQ96,
      currencyRaised: usd(6848),
      totalCleared: 0n,
      isGraduated: true,
      balanceOf: usd(5000),
      allowance: req.args?.length === 3 ? [0n, 0, 0] : 0n,
    };
    return v[req.functionName] as T;
  };
}

function ticketFor(now: number): IssuedTicket {
  return { ticket: { kind: 1, subject: PAOLO, nullifier: "123456789", expiresAt: String(now + 86_400) }, signature: "0x00", credential: "orb" };
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
  const c = { ...base, checkpoints };
  const clearingQ96 = checkpoints.at(-1)!.clearingPriceQ96;

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
      read: fakeRead(clearingQ96),
      walletKind: "embedded",
      switchWallet: () => {},
      Gate: StubGate,
      formDefaults: state === "invalid" ? { budget: "9,000.00", max: "1,705.00" } : state === "unverified" || state === "refused" ? {} : { budget: "2,000.00" },
    };
  }, [state, now, clearingQ96]);

  const href = (t: CardTab) => `/design/auction?state=${state}${t === "overview" ? "" : `&tab=${t}`}`;
  return (
    <HandlesFixture.Provider value={HANDLES}>
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
            <CardPageView key={state} c={c} me={PAOLO} now={now} block={FIXTURE_HEAD} tab={tab} tabHref={href} />
          </main>
        </div>
      </AuctionIoContext.Provider>
    </HandlesFixture.Provider>
  );
}
