"use client";

import type * as React from "react";
import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheckIcon, CheckIcon, CircleCheckIcon, ExternalLinkIcon, LoaderIcon, LockIcon, PackageCheckIcon, PackageOpenIcon, SmartphoneIcon, TimerOffIcon, XIcon } from "lucide-react";
import { abi } from "@kura/shared";
import { AddressName } from "@/components/address-name";
import { Button, CardArt, notify } from "@/components/kura";
import { TxStepper, useIsDesktop } from "@/components/tx-stepper";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useDisplayName } from "@/hooks/use-handles";
import { apiFetch, useKuraUser } from "@/hooks/use-kura-user";
import { useNow } from "@/hooks/use-now";
import { addresses, explorerTx, publicClient } from "@/lib/chain";
import { agoLong } from "@/lib/card-view";
import { shortHash } from "@/lib/format";
import {
  CHECKLIST,
  RELEASED_STATE,
  checklist,
  describeReleaseError,
  mmss,
  releaseArgs,
  releaseRetryable,
  releaseStage,
  ticketSpent,
  type CheckStatus,
  type PendingRelease,
  type ReleaseStage,
} from "@/lib/release";
import { TxError, useSendTx, type Step } from "@/lib/tx";
import { cn } from "@/lib/utils";

export type ReleaseCard = { name: string; image?: string; ensName: string };

// ---------------------------------------------------------------------------------------------------------------------
// Live flow: the owner verifies with Passport in their own Kura app (the card page's "Collect at the counter"); the
// station polls for that ticket, then sends confirmRelease from the vendor wallet.

const POLL_MS = 3000;

async function fetchPending(cardId: bigint, identityToken: string | null): Promise<PendingRelease | null> {
  const r = await apiFetch(`/api/release/pending?cardId=${cardId}`, { identityToken });
  if (!r.ok) throw new Error(`pending ${r.status}`);
  return ((await r.json()) as { pending: PendingRelease | null }).pending;
}

/** Marks a ticket used up (released, or refused for good) so the station stops offering it. Best effort. */
async function consumeTicket(id: string, identityToken: string | null) {
  await apiFetch("/api/release/consume", { method: "POST", body: JSON.stringify({ id }), identityToken }).catch(() => null);
}

/** Hand over a Whole card (tM3Hy, ykB2t): wait for the owner's Passport ticket, then `confirmRelease` from the vendor. */
export function ReleasePanel({
  cardId,
  holder,
  card,
  redeemedAt,
  onClose,
  onReleased,
  onShowReleased,
}: {
  cardId: bigint;
  holder: `0x${string}`;
  card: ReleaseCard;
  /** When the card came out of a buyout: the redeem time (unix seconds). */
  redeemedAt?: number | null;
  onClose: () => void;
  onReleased?: () => void;
  /** "Done" on the confirmation. */
  onShowReleased?: () => void;
}) {
  const now = useNow(1000);
  const { identityToken } = useKuraUser();
  const queryClient = useQueryClient();
  const { send, walletKind } = useSendTx();
  const holderName = useDisplayName(holder);
  const [released, setReleased] = useState<{ hash: `0x${string}` | null } | null>(null);
  // The ticket a confirmation is using: held so the stage stays put while the send and the indexer catch up (the
  // pending route stops returning it as soon as the card is Released).
  const [held, setHeld] = useState<PendingRelease | null>(null);
  const key = ["release-pending", cardId.toString()];
  const polled = useQuery({
    queryKey: key,
    queryFn: () => fetchPending(cardId, identityToken ?? null),
    enabled: !!identityToken && !released && !held,
    refetchInterval: POLL_MS,
  });
  const pending = held ?? polled.data ?? null;
  const stage = releaseStage({ pending, released, now });
  const ready = stage.kind === "verified" ? stage.pending : null;

  const steps: Step[] = [
    {
      id: "release",
      label: "Record release and revoke the ENS name",
      // Re-read on retry: once the vault shows the card released, the release is not sent again.
      skip: async () => {
        const c = (await publicClient.readContract({ address: addresses.cardVault, abi: abi.cardVault, functionName: "cards", args: [cardId] })) as { state: number };
        return Number(c.state) === RELEASED_STATE;
      },
      run: async () => {
        const t = held ?? ready;
        if (!t || Number(t.ticket.expiresAt) <= Math.floor(Date.now() / 1000)) {
          throw new TxError("The release ticket expired. Ask the holder to verify again in their app.", { name: "Expired" });
        }
        setHeld(t);
        const sent = await send({ to: addresses.cardVault, abi: abi.cardVault, functionName: "confirmRelease", args: releaseArgs(cardId, t) });
        void consumeTicket(t.id, identityToken ?? null);
        return sent;
      },
    },
  ];

  const restart = () => {
    setHeld(null);
    void queryClient.invalidateQueries({ queryKey: key });
  };

  return (
    <ReleaseShell card={card} onClose={onClose}>
      <ReleaseBody
        cardId={cardId}
        card={card}
        holder={holder}
        redeemedAt={redeemedAt}
        stage={stage}
        now={now}
        unreachable={polled.isError}
        onClose={onClose}
        onShowReleased={onShowReleased}
        confirm={
          <TxStepper
            steps={steps}
            cta="Confirm handover"
            ctaIcon={ready ? <PackageOpenIcon aria-hidden /> : <LockIcon aria-hidden />}
            ctaClassName={ready ? "bg-kin text-kin-ink hover:bg-kin/90" : "bg-surface-2 text-muted-foreground disabled:opacity-100"}
            disabled={!ready}
            title="Handing over"
            failedTitle="The handover didn't go through"
            describeError={describeReleaseError}
            retryable={releaseRetryable}
            backLabel="Wait for a new check"
            onCancel={restart}
            onError={(_r, revert) => {
              const t = held ?? ready;
              if (t && ticketSpent(revert)) void consumeTicket(t.id, identityToken ?? null);
            }}
            onDone={(results) => {
              const hash = results.find((r) => r.id === "release")?.hash ?? null;
              setReleased({ hash });
              notify({ title: "Handover confirmed", body: `${card.name} released to ${holderName}`, tone: "good", icon: <PackageCheckIcon /> });
              onReleased?.();
            }}
            successToast={false}
            walletKind={walletKind}
          />
        }
      />
    </ReleaseShell>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Presentational

/** The right-hand panel next to the inventory from `md` up; a bottom sheet below. */
export function ReleaseShell({ card, onClose, children }: { card: ReleaseCard; onClose: () => void; children: React.ReactNode }) {
  const isDesktop = useIsDesktop();
  const head = (
    <div className="flex items-start justify-between gap-3">
      <h2 className="font-display text-[24px] leading-tight font-semibold text-text">Hand over {card.name}</h2>
      <button type="button" aria-label="Close" onClick={onClose} className="-mr-1 rounded-md p-1 text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/50">
        <XIcon className="size-5" />
      </button>
    </div>
  );
  if (!isDesktop) {
    return (
      <Sheet open onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="bottom" showCloseButton={false} className="max-h-[92dvh] overflow-y-auto rounded-t-2xl border-border bg-surface px-5 pt-3 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
          <span aria-hidden className="mx-auto h-1 w-9 rounded-full bg-border" />
          <SheetTitle className="sr-only">Hand over {card.name}</SheetTitle>
          <SheetDescription className="sr-only">Passport check and handover</SheetDescription>
          <div className="flex flex-col gap-5">{head}{children}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <section aria-label={`Hand over ${card.name}`} className="flex flex-col gap-5 rounded-2xl border border-kin/40 bg-surface p-6 xl:sticky xl:top-6">
      {head}
      {children}
    </section>
  );
}

function Dot({ status }: { status: CheckStatus }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-full", status === "done" ? "bg-good" : status === "active" ? "bg-kin" : "bg-surface-2")} />;
}

function StatusRow({ icon, children, trailing }: { icon: React.ReactNode; children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div role="status" className="flex items-center gap-3 rounded-lg bg-bg px-4 py-3 text-[14px] text-text [&_svg]:size-4 [&_svg]:shrink-0">
      {icon}
      <span className="min-w-0 flex-1">{children}</span>
      {trailing && <span className="shrink-0 font-mono text-[13px] text-text-2 tabular-nums">{trailing}</span>}
    </div>
  );
}

function Notice({ tone, icon, title, body, action }: { tone: "shu" | "neutral"; icon: React.ReactNode; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className={cn("flex aspect-[352/260] max-h-[300px] w-full flex-col items-center justify-center gap-3 rounded-2xl border p-6 text-center", tone === "shu" ? "border-shu/30 bg-shu-soft" : "border-dashed border-border bg-bg")}>
      <span className={cn("flex size-12 items-center justify-center rounded-full [&_svg]:size-6", tone === "shu" ? "bg-shu/15 text-shu" : "bg-surface-2 text-text-2")}>{icon}</span>
      <div className="flex flex-col gap-1">
        <p className="text-[16px] font-semibold text-text">{title}</p>
        {body && <p className="text-[13px] text-text-2">{body}</p>}
      </div>
      {action}
    </div>
  );
}

function Verified({ holder }: { holder: string }) {
  return (
    <div className="flex aspect-[352/260] max-h-[300px] w-full flex-col items-center justify-center gap-4 rounded-2xl border border-good/40 bg-good-soft p-6 text-center">
      <span className="flex size-24 items-center justify-center rounded-full border-2 border-good text-good [&_svg]:size-10">
        <BadgeCheckIcon aria-hidden strokeWidth={1.75} />
      </span>
      <div className="flex flex-col gap-2">
        <p className="text-[18px] font-semibold text-text">Passport verified</p>
        <p className="inline-flex flex-wrap items-center justify-center gap-1.5 font-mono text-[13px] text-text-2">
          Ticket issued for <AddressName address={holder} avatar={false} copyable={false} className="[&>span]:text-[13px] [&>span]:text-text-2" />
        </p>
      </div>
    </div>
  );
}

const ASK = "Ask the holder to open the card in Kura and tap Collect at the counter. Only the card's owner can start this, from their own Kura app.";
const INSTRUCTIONS: Partial<Record<ReleaseStage["kind"], string>> = {
  verified: "The holder passed the Passport check in their app. Hand over the card, then confirm. This records the release and revokes the ENS name.",
};

/** Everything under the panel's title, for one stage. `confirm` is the Confirm handover control (a TxStepper live). */
export function ReleaseBody({
  cardId,
  card,
  holder,
  redeemedAt,
  stage,
  now,
  unreachable = false,
  onClose,
  onShowReleased,
  confirm,
}: {
  cardId: bigint;
  card: ReleaseCard;
  holder: string;
  redeemedAt?: number | null;
  stage: ReleaseStage;
  now: number;
  /** The pending-ticket poll is failing. */
  unreachable?: boolean;
  onClose: () => void;
  onShowReleased?: () => void;
  confirm: React.ReactNode;
}) {
  const dots = checklist(stage);
  const holderName = useDisplayName(holder);

  if (stage.kind === "released") {
    return (
      <>
        <HolderRow card={card} holder={holder} redeemedAt={redeemedAt} now={now} />
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-good/40 bg-good-soft px-6 py-8 text-center">
          <span className="flex size-16 items-center justify-center rounded-2xl bg-good/15 text-good [&_svg]:size-8">
            <PackageCheckIcon aria-hidden />
          </span>
          <div className="flex flex-col gap-1.5">
            <p className="font-display text-[22px] font-semibold text-text">Handover confirmed</p>
            <p className="text-[14px] text-text-2">
              {card.name} is released to {holderName}. The vault no longer holds it and <span className="font-mono text-[13px] text-muted-foreground">{card.ensName}</span> is revoked.
            </p>
          </div>
        </div>
        {stage.hash && (
          <StatusRow icon={<CircleCheckIcon className="text-good" />} trailing={
            <a href={explorerTx(stage.hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-kin hover:underline">
              {shortHash(stage.hash)}<ExternalLinkIcon className="size-3.5" />
            </a>
          }>
            Release recorded on-chain
          </StatusRow>
        )}
        <Checklist dots={dots} />
        <div className="flex flex-col gap-2.5 sm:flex-row">
          {/* A new tab, so the station keeps its place; /app renders for any signed-in wallet, the vendor's included. */}
          <Button asChild variant="secondary" size="md" className="sm:flex-1">
            <Link href={`/app/cards/${cardId}`} target="_blank" rel="noreferrer">View card page<ExternalLinkIcon aria-hidden /></Link>
          </Button>
          <Button variant="redeem" size="md" className="sm:flex-1" onClick={onShowReleased ?? onClose}>
            <CheckIcon aria-hidden />Done
          </Button>
        </div>
      </>
    );
  }

  const main =
    stage.kind === "verified" ? <Verified holder={holder} />
    : stage.kind === "expired" ? (
      <Notice tone="neutral" icon={<TimerOffIcon />} title="The release ticket expired" body="Tickets last 15 minutes. Ask the holder to verify again in their app; this updates by itself." />
    ) : (
      <Notice tone="neutral" icon={<SmartphoneIcon />} title="Waiting for the holder" body="They open this card in Kura, tap Collect at the counter and verify with Passport. This updates by itself." />
    );

  const status =
    stage.kind === "verified" ? (
      <StatusRow icon={<CircleCheckIcon className="text-good" />}>Release ticket signed · valid {mmss(stage.secondsLeft)}</StatusRow>
    ) : unreachable ? (
      <StatusRow icon={<LoaderIcon className="animate-spin text-shu" />}>Can&apos;t reach Kura right now · retrying…</StatusRow>
    ) : (
      <StatusRow icon={<LoaderIcon className="animate-spin text-kin" />}>Waiting for the holder&apos;s Passport check…</StatusRow>
    );

  return (
    <>
      <HolderRow card={card} holder={holder} redeemedAt={redeemedAt} now={now} />
      <p className="text-[14px] leading-relaxed text-text-2">{INSTRUCTIONS[stage.kind] ?? ASK}</p>
      {main}
      {status}
      <Checklist dots={dots} />
      {confirm}
    </>
  );
}

function HolderRow({ card, holder, redeemedAt, now }: { card: ReleaseCard; holder: string; redeemedAt?: number | null; now: number }) {
  return (
    <div className="flex items-center gap-4 rounded-xl bg-bg px-4 py-3.5">
      {card.image ? (
        <CardArt src={card.image} alt="" className="h-[46px] w-[33px] shrink-0 rounded-[2px] shadow-none" />
      ) : (
        <span aria-hidden className="h-[46px] w-[33px] shrink-0 rounded-[2px] bg-surface-2" />
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[14px] text-text">
          To <AddressName address={holder} avatar={false} copyable={false} className="[&>span]:text-[14px]" />
        </span>
        {redeemedAt != null && <span className="text-[12px] text-text-2">Redeemed {agoLong(redeemedAt, now)}</span>}
      </div>
    </div>
  );
}

function Checklist({ dots }: { dots: CheckStatus[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {CHECKLIST.map((label, i) => (
        <li key={label} data-status={dots[i]} className={cn("flex items-center gap-3 text-[13px]", dots[i] === "pending" ? "text-muted-foreground" : "text-text")}>
          <Dot status={dots[i]!} />
          {label}
        </li>
      ))}
    </ol>
  );
}

/** A Confirm handover button for previews: the locked or the enabled look, sending nothing. */
export function StaticConfirm({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <Button variant="redeem" size="md" className="w-full"><PackageOpenIcon aria-hidden />Confirm handover</Button>
  ) : (
    <Button variant="disabled" size="md" className="w-full" aria-disabled><LockIcon aria-hidden />Confirm handover</Button>
  );
}
