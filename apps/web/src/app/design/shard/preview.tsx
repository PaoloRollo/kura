"use client";

import Link from "next/link";
import { CircleDollarSignIcon, GavelIcon } from "lucide-react";
import { BarChip, EnsName, TopBar } from "@/components/kura";
import { CardLoading, CardNotFound } from "@/components/card-page-parts";
import { NAV } from "@/components/site-header";
import { ShardWizard, useUrlStepNav, type ShardDone, type WizardStep } from "@/components/shard-wizard";
import { TxStepper, describeTxError } from "@/components/tx-stepper";
import { useCard } from "@/hooks/use-card";
import { HandlesFixture } from "@/hooks/use-handles";
import { useVaultFeeBps } from "@/hooks/use-vault-fee";
import { saleHalf, shardRevertMessage, type ShardParams } from "@/lib/shard-math";
import { TxError } from "@/lib/tx-core";
import { cn } from "@/lib/utils";
import { HANDLES, PAOLO, cardFixture } from "../card/fixtures";
import { SHARD_PREVIEWS, type ShardPreviewState } from "./states";


// The live card 1's owner on Sepolia, so `live` passes the owner gate.
const LIVE_OWNER = "0xDeADaD159DF0923dAF871f8B4740eD7f7F417ee9";

/** Nothing is sent from a preview: the CTA runs one step that the vault "rejects", to show the failure sheet (g5bcZ). */
function PreviewSubmit({ p, disabled }: { p: ShardParams; disabled: boolean }) {
  return (
    <TxStepper
      steps={[{ id: "shard", label: `Shard into ${p.totalShards} and auction ${saleHalf(p.totalShards)}`, run: async () => { await new Promise((r) => setTimeout(r, 900)); throw new TxError("preview", { name: "WrongState" }); } }]}
      cta="Create shards and open auction"
      ctaIcon={<GavelIcon aria-hidden />}
      title="Opening your auction"
      failedTitle="The auction didn't open"
      disabled={disabled}
      describeError={(e, r) => shardRevertMessage(r.inner?.name ?? r.name) ?? describeTxError(e, r)}
      retryable={(r) => !shardRevertMessage(r.inner?.name ?? r.name)}
      backLabel="Edit settings"
      successToast={false}
    />
  );
}

function LiveShard({ id, now }: { id: bigint; now: number }) {
  const c = useCard(id);
  const feeBps = useVaultFeeBps();
  const nav = useUrlStepNav();
  if (c.isLoading) return <CardLoading />;
  if (!c.card) return <CardNotFound id={id.toString()} />;
  return <ShardWizard c={c} me={LIVE_OWNER} feeBps={feeBps} now={now} cardHref={`/design/card?state=live&id=${id}`} nav={nav} renderSubmit={(p, disabled) => <PreviewSubmit p={p} disabled={disabled} />} />;
}

export function ShardPreview({ state, now, liveId }: { state: ShardPreviewState; now: number; liveId: bigint }) {
  const nav = useUrlStepNav();
  const fixture = cardFixture(state === "notowner" ? "whole" : state === "auctioning" ? "auctioning" : "whole-owner", now);
  const c = state === "noprice" ? { ...fixture, price: { ...fixture.price!, usd: null, adjustedUsd: null } } : fixture;
  const step: WizardStep = state === "step2" || state === "noprice" || state === "invalid" ? 2 : state === "step3" ? 3 : 1;
  const done: ShardDone | null = state === "done"
    ? { params: { totalShards: 32, floorUsdcPerShard: 781_250_000n, tickUsdcPerShard: 7_812_500n, reserveUsdc: 0n, durationBlocks: 50_400 }, hash: "0x3a1f8e2b9c4d5a6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c49f2", at: now,
        created: { shardToken: "0x8c0B76235b3c4D179C0576517ae1C66640C8cEBf", auction: "0xdb6E8ADEdfd5dA3A50b9c738755770EDD98E5cCb", endBlock: 11_832_178n, refBlock: 11_781_778n, hash: null, source: "receipt" } }
    : null;
  return (
    <HandlesFixture.Provider value={state === "live" ? null : HANDLES}>
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
              <span className="inline-flex h-9 items-center rounded-md border border-border px-3"><EnsName name="paolo.kura.eth" copyable={false} /></span>
            </>
          }
        />
        <nav aria-label="Preview states" data-preview-nav className="flex flex-wrap gap-2 border-b border-border px-4 py-2 lg:px-12">
          {SHARD_PREVIEWS.map((s) => (
            <Link key={s} href={`/design/shard?state=${s}`} className={cn("rounded-full px-2.5 py-1 text-[12px]", s === state ? "bg-surface-2 text-text" : "text-muted-foreground")}>{s}</Link>
          ))}
        </nav>
        <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">
          {state === "live" ? (
            <LiveShard id={liveId} now={now} />
          ) : (
            <ShardWizard
              key={state}
              c={c}
              me={PAOLO}
              feeBps={250}
              now={now}
              cardHref="/design/card?state=whole-owner"
              nav={nav}
              initialStep={step}
              initialDone={done}
              initialFloor={state === "invalid" ? "1,200.0000005" : undefined}
              renderSubmit={(p, disabled) => <PreviewSubmit p={p} disabled={disabled} />}
            />
          )}
        </main>
      </div>
    </HandlesFixture.Provider>
  );
}
