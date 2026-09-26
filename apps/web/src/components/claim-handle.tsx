"use client";

import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { and, desc, eq, gt } from "@ponder/client";
import { usePonderQuery } from "@ponder/react";
import { CheckIcon, CircleCheckIcon, CircleXIcon, CompassIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import type { Address } from "viem";
import { abi, RESERVED_HANDLES } from "@kura/shared";
import { useQuery } from "@tanstack/react-query";
import { AmountInput, Button, EnsName, notify } from "@/components/kura";
import { describeTxError, TxStepper } from "@/components/tx-stepper";
import { useHandlesState } from "@/hooks/use-handles";
import { useKuraUser } from "@/hooks/use-kura-user";
import { useCardMetas } from "@/hooks/use-vendor-data";
import { addresses, explorerTx, publicClient } from "@/lib/chain";
import { indexerCollectors } from "@/lib/collectors";
import { shardsFixed, shortAddress, shortHash } from "@/lib/format";
import { handleMessage, normalizeHandle, reasonFromRevert, type Availability } from "@/lib/handles";
import { schema, t, type Row } from "@/lib/ponder";
import { useSendTx, type Revert, type Step } from "@/lib/tx";
import { cn } from "@/lib/utils";

const PARENT = `${addresses.ensParentLabel}.eth`;

export type CheckState = null | { checking: true } | Availability | { error: string };
export type TopHolding = { card: string; shards: string; pct: string } | null;

// ---------------------------------------------------------------------------------------------------------------------
// Presentational (D0ZWe)

/** The Claim handle screen: heading, handle field with its live check, the "How it will look" row and the CTA slot. */
export function ClaimHandleView({
  label,
  onLabel,
  check,
  holding,
  fallbackName,
  hints,
  cta,
}: {
  label: string;
  onLabel: (v: string) => void;
  check: CheckState;
  holding: TopHolding;
  /** Shown in the preview row while the field is empty (the short address). */
  fallbackName: string;
  hints: { label: string; note: string }[];
  cta: React.ReactNode;
}) {
  const ok = !!check && "available" in check && check.available;
  const bad = !!check && (("available" in check && !check.available) || "error" in check);
  const message = !check ? handleMessage({ available: false, reason: "INVALID" }, label, PARENT)
    : "error" in check ? check.error
    : handleMessage(check, label, PARENT);
  const preview = label ? `${label}.${PARENT}` : fallbackName;
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-7.5rem)] md:min-h-[calc(100dvh-12rem)] w-full max-w-[420px] flex-col">
      <div className="flex justify-end">
        <Link href="/app" className="text-[13px] text-text-2 hover:text-text">Skip for now</Link>
      </div>
      <div className="flex flex-1 flex-col gap-6 pt-10">
        <span lang="ja" aria-hidden className="font-display text-[44px] leading-none text-shu">蔵</span>
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-[32px] leading-[1.15] font-semibold text-text">Claim your name in the vault</h1>
          <p className="text-[14px] leading-relaxed text-text-2">
            Your handle shows on every card you hold, every bid and every holder list. It lives on ENS, and its records are yours alone.
          </p>
        </div>
        <AmountInput
          aria-label="Your Kura handle"
          value={label}
          onChange={(e) => onLabel(e.target.value.toLowerCase().replace(/\s+/g, ""))}
          placeholder="yourname"
          inputMode="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={32}
          style={{ width: `${Math.max(label.length || 8, 1)}ch`, flex: "none" }}
          unit={`.${PARENT}`}
          unitClassName="-ml-3 font-mono text-[18px] text-muted-foreground"
          tone={ok ? "good" : bad && label ? "shu" : "default"}
          trailing={
            !check ? null
              : "checking" in check ? <Loader2Icon aria-label="Checking" className="size-5 animate-spin text-text-2" />
              : ok ? <CircleCheckIcon aria-label="Available" className="size-5 text-good" />
              : label ? <CircleXIcon aria-label="Not available" className="size-5 text-shu" />
              : null
          }
          hint={<span aria-live="polite">{message}</span>}
          hintClassName={cn("text-[12px]", ok ? "text-good-fg" : bad && label ? "text-shu" : "text-muted-foreground")}
        />
        <div className="flex flex-col gap-2.5">
          <p className="text-[12px] text-muted-foreground">How it will look</p>
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3.5">
            <span aria-hidden className="size-9 shrink-0 rounded-full bg-[linear-gradient(-135deg,var(--kura-s7)_15%,var(--kura-shu)_85%)]" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-mono text-[14px] text-text">{preview}</span>
              <span className="truncate text-[12px] text-text-2">
                {holding ? `holds ${holding.shards} shards of ${holding.card}` : "holds no shards yet"}
              </span>
            </span>
            {holding && <span className="shrink-0 font-mono text-[13px] text-s1">{holding.pct}</span>}
          </div>
          {hints.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {hints.map((h) => (
                <span key={h.label} className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 font-mono text-[11px] text-text-2">
                  <CircleXIcon aria-hidden className="size-3.5 text-shu" />
                  {h.label} · {h.note}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-3 pt-8">
        {cta}
        <p className="text-center text-[12px] text-muted-foreground">Free, one per wallet. Gas is covered.</p>
      </div>
    </div>
  );
}

/** After the claim (D0ZWe language, laid out like UwCiy / anR2F): the new name, its tx and whether it is indexed yet. */
export function ClaimedView({ label, hash, live }: { label: string; hash?: string; live: boolean }) {
  const name = `${label}.${PARENT}`;
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-7.5rem)] w-full max-w-[420px] flex-col md:min-h-[calc(100dvh-12rem)]">
      <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
        <span className="flex size-[120px] items-center justify-center rounded-full border-[1.5px] border-good bg-good-soft text-good">
          <CheckIcon aria-hidden className="size-12" strokeWidth={2.25} />
        </span>
        <h1 className="flex flex-col items-center gap-2 font-display text-[32px] leading-tight font-semibold text-text">
          You&apos;re
          <EnsName name={name} avatar={false} maxWidthClassName="max-w-[20rem]" className="[&>span]:text-[22px] [&>span]:font-normal" />
        </h1>
        <p className="max-w-[20rem] text-[14px] leading-relaxed text-text-2">Your handle is live on ENS and shows next to everything you own on Kura.</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {hash && (
            <a
              href={explorerTx(hash)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 font-mono text-[12px] text-text-2 hover:text-text"
            >
              tx {shortHash(hash)}
              <ExternalLinkIcon aria-hidden className="size-3" />
            </a>
          )}
          <span
            aria-live="polite"
            className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px]", live ? "bg-good-soft text-good-fg" : "bg-surface text-text-2")}
          >
            {live ? <CheckIcon aria-hidden className="size-3" /> : <Loader2Icon aria-hidden className="size-3 animate-spin" />}
            {live ? "Live" : "Indexing…"}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2.5 pt-8">
        <Button asChild variant="primary" size="md" className="w-full">
          <Link href="/app"><CompassIcon />Explore auctions</Link>
        </Button>
        <Button asChild variant="secondary" size="md" className="w-full">
          <Link href={PROFILE_HREF}>View my profile</Link>
        </Button>
      </div>
    </div>
  );
}

const PROFILE_HREF = "/app/profile";

// ---------------------------------------------------------------------------------------------------------------------
// Data

type Db = Parameters<Parameters<typeof usePonderQuery>[0]["queryFn"]>[0];
type BalanceRow = Row<typeof schema.shardBalances>;
type ShardingRow = Row<typeof schema.shardings>;

/** The wallet's largest shard position: card name, shards held and its share of the supply. */
export function useTopHolding(address: string | null): TopHolding {
  const holder = address?.toLowerCase() ?? "";
  const balanceQuery = useMemo(
    () => (db: Db) =>
      db.select().from(t(schema.shardBalances))
        .where(and(eq(t(schema.shardBalances.holder), holder), gt(t(schema.shardBalances.balance), 0n)))
        .orderBy(desc(t(schema.shardBalances.balance))).limit(1) as Promise<BalanceRow[]>,
    [holder],
  );
  const top = usePonderQuery({ queryFn: balanceQuery, enabled: !!holder }).data?.[0];
  const token = top?.shardToken ?? "";
  const shardingQuery = useMemo(
    () => (db: Db) => db.select().from(t(schema.shardings)).where(eq(t(schema.shardings.shardToken), token)).limit(1) as Promise<ShardingRow[]>,
    [token],
  );
  const sharding = usePonderQuery({ queryFn: shardingQuery, enabled: !!token }).data?.[0];
  const metas = useCardMetas(sharding ? [sharding.cardId] : []);
  if (!top || !sharding) return null;
  const meta = metas.get(sharding.cardId);
  const card = meta ? meta.name.replace(/ \([^)]*\) #\d+$/, "") : `card #${sharding.cardId}`;
  const total = BigInt(sharding.totalShards) * 10n ** 18n;
  const pct = total > 0n ? `${(Number((top.balance * 10_000n) / total) / 100).toFixed(1)}%` : "";
  return { card, shards: shardsFixed(top.balance, top.balance % 10n ** 18n === 0n ? 0 : 1), pct };
}

/** Reads the availability route for `label`, debounced 300 ms; the answer for the current label wins. */
function useAvailability(label: string, address: string | null): [CheckState, (c: CheckState) => void] {
  const [answer, setAnswer] = useState<{ label: string; check: CheckState } | null>(null);
  useEffect(() => {
    if (!label) return;
    let live = true;
    const timer = setTimeout(async () => {
      let check: CheckState;
      try {
        const q = new URLSearchParams({ label, ...(address ? { address } : {}) });
        const res = await fetch(`/api/ens/available?${q}`);
        if (!res.ok) throw new Error(String(res.status));
        check = (await res.json()) as Availability;
      } catch {
        check = { error: "Couldn't check the handle right now. Try again in a moment." };
      }
      if (live) setAnswer({ label, check });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [label, address]);
  const check: CheckState = !label ? null : answer?.label === label ? answer.check : { checking: true };
  return [check, (c) => setAnswer({ label, check: c })];
}

/** Hint chips from real data: one reserved handle and one handle already taken, when there is one. */
function hintsFrom(handles: Record<string, string>) {
  const taken = Object.values(handles).find((l) => l !== "vendor");
  return [{ label: RESERVED_HANDLES[1], note: "reserved" }, ...(taken ? [{ label: taken, note: "taken" }] : [])];
}

/** The onboarding page: claim `<label>.kura.eth` with `CardNames.registerCollector`, then confirm it on the page. */
export function ClaimHandle() {
  const router = useRouter();
  const { address } = useKuraUser();
  const { send, walletKind } = useSendTx();
  const { handles, ready } = useHandlesState();
  const [label, setLabel] = useState("");
  const [check, setCheck] = useAvailability(normalizeHandle(label), address);
  const holding = useTopHolding(address);
  const [claimed, setClaimed] = useState<{ label: string; hash?: string } | null>(null);
  const me = address?.toLowerCase() ?? "";
  const named = !!me && ready && !!handles[me];

  // One handle per wallet: a wallet that already has one when the page loads has nothing to do here. Decided once, on
  // the first loaded collectors table, so the handle appearing right after a claim never skips the success state.
  const loadChecked = useRef(false);
  useEffect(() => {
    if (!me || !ready || loadChecked.current) return;
    loadChecked.current = true;
    if (named && !claimed) router.replace("/app");
  }, [me, ready, named, claimed, router]);

  // After the claim, poll the collectors lookup until the indexer has the row (the live query usually gets there first).
  const polled = useQuery({
    queryKey: ["collector-label", me],
    queryFn: () => indexerCollectors.byAddress(me),
    enabled: !!claimed && !!me && handles[me] !== claimed.label,
    refetchInterval: 2000,
  }).data;
  const live = !!claimed && (handles[me] === claimed.label || polled === claimed.label);

  const available = !!check && "available" in check && check.available;
  const steps: Step[] = [
    {
      id: "claim",
      label: `Claim ${label}.${PARENT}`,
      // A retry after the claim went through must not send it again.
      skip: async () =>
        !!address && (await publicClient.readContract({ abi: abi.cardNames, address: addresses.cardNames, functionName: "collectorLabels", args: [address as Address] })) === label,
      run: () => send({ to: addresses.cardNames, abi: abi.cardNames, functionName: "registerCollector", args: [label] }),
    },
  ];

  function describeError(_e: unknown, revert: Revert) {
    const reason = reasonFromRevert(revert.inner?.name ?? revert.name);
    if (!reason) return null;
    const result: Availability = { available: false, reason };
    setCheck(result);
    return { title: handleMessage(result, label, PARENT), body: "Nothing was sent or charged. Pick another handle." };
  }

  if (claimed) return <ClaimedView label={claimed.label} hash={claimed.hash} live={live} />;

  return (
    <ClaimHandleView
      label={label}
      onLabel={setLabel}
      check={check}
      holding={holding}
      fallbackName={address ? shortAddress(address) : ""}
      hints={hintsFrom(handles)}
      cta={
        <TxStepper
          steps={steps}
          walletKind={walletKind}
          cta={`Claim ${label || "your handle"}${label ? `.${PARENT}` : ""}`}
          title="Claiming your handle"
          failedTitle="Your handle wasn't claimed"
          disabled={!available || !address}
          describeError={(e, r) => describeError(e, r) ?? describeTxError(e, r)}
          // A handle revert repeats on retry: send the user back to change the handle instead.
          retryable={(r) => !reasonFromRevert(r.inner?.name ?? r.name)}
          backLabel="Edit handle"
          // The success state fires its own "Handle claimed" toast.
          successToast={false}
          onDone={(results) => {
            setClaimed({ label, hash: results.find((r) => r.id === "claim")?.hash });
            notify({ title: "Handle claimed", body: `You're ${label}.${PARENT}`, tone: "good", icon: <CheckIcon /> });
          }}
        />
      }
    />
  );
}
