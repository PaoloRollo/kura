"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CircleDollarSignIcon } from "lucide-react";
import { encodeAbiParameters, encodeEventTopics, type Address, type TransactionReceipt } from "viem";
import { abi, usdcPerShardToQ96 } from "@kura/shared";
import { BarChip, Button, EnsName, TopBar } from "@/components/kura";
import { CardPageView, identityOf } from "@/components/card-page-view";
import { PayoutPanel } from "@/components/payout-panel";
import { RedeemPage } from "@/components/redeem-panel";
import { SendShardsSheet } from "@/components/send-shards";
import { NAV } from "@/components/site-header";
import { AppraiseError, VaultIoContext, type VaultIo, type VaultRead } from "@/components/vault-io";
import { showVaultSuccess } from "@/components/vault-success";
import type { CardData } from "@/hooks/use-card";
import { HandlesFixture } from "@/hooks/use-handles";
import type { AppraiseResult } from "@/lib/appraise";
import { addresses } from "@/lib/chain";
import type { CardTab } from "@/lib/card-view";
import { TxError, type SendInput, type Sent } from "@/lib/tx-core";
import { cn } from "@/lib/utils";
import { AIKO, FIXTURE_HEAD, HANDLES, KENJI, PAOLO, cardFixture } from "../card/fixtures";
import { REDEEM_PREVIEWS, type RedeemPreviewState } from "./states";

const S = 10n ** 18n;
const usd = (dollars: number) => BigInt(Math.round(dollars * 100)) * 10_000n;
const fakeHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
/** The fixture's shard token (every fixture state shares it). */
const token = cardFixture("sharded", 0).sharding!.shardToken as Address;
const PAYOUT_STATES: readonly RedeemPreviewState[] = ["payout", "payout-banner", "payout-claimed"];

function log(eventName: "CardRedeemed" | "PayoutClaimed", args: Record<string, unknown>, data: bigint[]) {
  return {
    address: addresses.cardVault,
    topics: encodeEventTopics({ abi: abi.cardVault, eventName, args } as never),
    data: encodeAbiParameters(data.map(() => ({ type: "uint256" })), data),
  };
}

/** A preview "send": waits like a block, then succeeds with the vault's event, or fails once with Expired. */
function fakeSend(state: RedeemPreviewState, token: Address) {
  let n = 0;
  let expiredOnce = state === "expired";
  return async (input: SendInput): Promise<Sent> => {
    await new Promise((r) => setTimeout(r, 900));
    n += 1;
    if (input.functionName === "redeem" && expiredOnce) {
      expiredOnce = false;
      throw new TxError("preview", { name: "Expired" });
    }
    const hash = fakeHash(0x5e2c0a + n);
    const logs = input.functionName === "redeem"
      ? [log("CardRedeemed", { id: 1n, shardToken: token, redeemer: PAOLO }, state === "full" ? [usd(1712), 0n, 0n] : [usd(1712), usd(5136), usd(128.4)])]
      : input.functionName === "claimPayout" ? [log("PayoutClaimed", { id: 1n, shardToken: token, holder: KENJI }, [S, usd(1712)])]
      : [];
    return { hash, receipt: { status: "success", blockNumber: 1n, logs, transactionHash: hash } as unknown as TransactionReceipt, gas: "sponsored" };
  };
}

/** Chain reads for the fixture: 16 shards, paolo's balance by state, $6,120 of USDC, nothing approved, 2.5% fee. */
function fakeRead(state: RedeemPreviewState, token: Address) {
  const mine = state === "full" ? 16n * S : state === "below" ? 15n * S / 2n : PAYOUT_STATES.includes(state) ? S : 13n * S;
  return async <T,>(req: VaultRead): Promise<T> => {
    const isToken = req.address.toLowerCase() === token.toLowerCase();
    const v: Record<string, unknown> = {
      totalSupply: 16n * S,
      balanceOf: isToken ? mine : state === "no-usdc" ? usd(248.5) : usd(6120),
      allowance: 0n,
      feeBps: 250,
      shardings: { clearingPriceQ96: usdcPerShardToQ96(usd(1712)) },
      cards: { state: 3, beneficialOwner: PAOLO },
    };
    return v[req.functionName] as T;
  };
}

function fakeAppraise(state: RedeemPreviewState, token: Address) {
  return async (): Promise<AppraiseResult> => {
    await new Promise((r) => setTimeout(r, 700));
    if (state === "no-price") throw new AppraiseError("NO_PRICE", "No market price available yet, try again later");
    const t = Math.floor(Date.now() / 1000);
    return {
      appraisal: { cardId: "1", shardToken: token, usdcPerShard: usd(1587.5).toString(), expiresAt: String(t + (state === "expired" ? 35 : 581)) },
      signature: "0x00",
      marketUsd: "25400.00",
      adjustedUsd: "25400",
      conditionMultiplier: 1,
      priceSource: `Scryfall USD · nonfoil · EN printing · NM ×1.00${state === "snapshot" ? " · cached" : ""}`,
      source: state === "snapshot" ? "snapshot" : "scryfall",
      pricedAt: state === "snapshot" ? t - 14 * 60 : t,
      clearingUsdcPerShard: usd(1712).toString(),
    };
  };
}

async function fakeResolve(input: string) {
  const label = input.trim().toLowerCase().replace(/\.kura\.eth$/, "");
  if (label === "kenji") return { ok: true as const, address: KENJI, name: "kenji.kura.eth" };
  if (label === "aiko") return { ok: true as const, address: AIKO, name: "aiko.kura.eth" };
  return { ok: false as const, error: "No collector with that handle" };
}

/** The fixture card for a state: sharded and settled, graduated or not, or bought out by paolo (payouts). */
function fixtureFor(state: RedeemPreviewState, now: number): CardData {
  if (PAYOUT_STATES.includes(state)) return cardFixture("whole-after-buyout", now);
  const c = cardFixture("sharded", now);
  if (state !== "not-graduated") return c;
  return { ...c, sharding: { ...c.sharding!, graduated: false, clearingUsdcPerShard: null } };
}

export function RedeemPreview({ state, now }: { state: RedeemPreviewState; now: number }) {
  const c = fixtureFor(state, now);
  const [sendOpen, setSendOpen] = useState(true);
  const io = useMemo<Partial<VaultIo>>(() => ({
    send: fakeSend(state, token),
    walletKind: "embedded",
    read: fakeRead(state, token),
    appraise: fakeAppraise(state, token),
    resolveHandle: fakeResolve,
  }), [state]);

  useEffect(() => {
    if (state === "redeemed") showVaultSuccess({ kind: "redeemed", cardId: 1n, hash: fakeHash(0x5e2c0a), buyoutPerShard: usd(1712), payoutUsdc: usd(5136), feeUsdc: usd(128.4), missing: 3n * S });
    else if (state === "payout-claimed") showVaultSuccess({ kind: "claimed", cardId: 1n, hash: fakeHash(0x5e2c0a), shardUnits: S, usdc: usd(1712), buyoutPerShard: usd(1712), redeemer: PAOLO });
    else showVaultSuccess(null);
    return () => showVaultSuccess(null);
  }, [state]);

  const me = PAYOUT_STATES.includes(state) ? KENJI : PAOLO;
  const href = (t: CardTab) => `/design/redeem?state=${state}${t === "overview" ? "" : `&tab=${t}`}`;
  const cc: CardData = { ...c, myBalance: PAYOUT_STATES.includes(state) ? 0n : c.myBalance };
  const identity = identityOf(cc);
  const s = c.allShardings[0];

  return (
    <HandlesFixture.Provider value={HANDLES}>
      <VaultIoContext.Provider value={io}>
        <div className="min-h-screen">
          <TopBar
            className="max-md:hidden"
            homeHref="/app"
            nav={NAV.collector}
            pathname="/app"
            exactHrefs={["/app"]}
            right={
              <>
                <BarChip icon={CircleDollarSignIcon} className="hidden sm:inline-flex">248.50 USDC</BarChip>
                <span className="inline-flex h-9 items-center rounded-md border border-border px-3"><EnsName name={me === PAOLO ? "paolo.kura.eth" : "kenji.kura.eth"} copyable={false} /></span>
              </>
            }
          />
          <nav aria-label="Preview states" data-preview-nav className="flex flex-wrap gap-2 border-b border-border px-4 py-2 lg:px-12">
            {REDEEM_PREVIEWS.map((p) => (
              <Link key={p} href={`/design/redeem?state=${p}`} className={cn("rounded-full px-2.5 py-1 text-[12px]", p === state ? "bg-surface-2 text-text" : "text-muted-foreground")}>{p}</Link>
            ))}
          </nav>
          <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">
            {state === "page" ? (
              <RedeemPage c={cc} me={PAOLO} identity={identity} />
            ) : state === "payout-banner" ? (
              <div className="mx-auto max-w-3xl">
                <PayoutPanel layout="banner" me={KENJI} cardName={identity.name} sharding={{ cardId: 1n, shardToken: token, buyoutPerShard: s.buyoutPerShard!, redeemer: s.redeemer }} />
              </div>
            ) : state === "send" || state === "send-unknown" ? (
              <>
                <Button variant="secondary" size="md" onClick={() => setSendOpen(true)}>Open the send sheet</Button>
                <SendShardsSheet open={sendOpen} onOpenChange={setSendOpen} cardName={identity.name} shardToken={token} balance={13n * S} supply={16n * S} initialTo={state === "send" ? "kenji.kura.eth" : "satoshi"} />
              </>
            ) : (
              <CardPageView c={cc} me={me} now={now} block={FIXTURE_HEAD} tab="overview" tabHref={href} />
            )}
          </main>
        </div>
      </VaultIoContext.Provider>
    </HandlesFixture.Provider>
  );
}
