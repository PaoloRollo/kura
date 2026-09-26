"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheckIcon, PackageIcon, RotateCcwIcon, ScanFaceIcon, TimerOffIcon, XIcon } from "lucide-react";
import { Button, notify } from "@/components/kura";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { WorldIdGate, worldIdErrorMessage, worldIdRefusalTitle } from "@/components/world-id-gate";
import { apiFetch, useKuraUser } from "@/hooks/use-kura-user";
import { useNow } from "@/hooks/use-now";
import type { ReleaseReady } from "@/hooks/use-world-id-ticket";
import { shortAddress } from "@/lib/format";
import { collectStage, mmss, type CollectStage } from "@/lib/release";
import { cn } from "@/lib/utils";

type Ready = { id: string; expiresAt: string } | null;
/** The holder's screen re-reads its ticket this often, to notice the vendor using it or the server dropping it. */
const POLL_MS = 5000;
const readyKey = (cardId: bigint) => ["release-ready", cardId.toString()];

/**
 * The owner's side of a handover: their waiting release ticket for the card (restored on reload, polled while it waits
 * or while `setChecking(true)` says the Passport check is open), the
 * Passport check that creates it, and cancelling it. A ticket that stops waiting on its own (the vendor used it, the
 * vault refused it, or the card changed) turns the screen to "ended" and refreshes the card.
 */
export function useCollect(cardId: bigint) {
  const { identityToken } = useKuraUser();
  const queryClient = useQueryClient();
  const now = useNow(1000);
  // The Passport check sheet is open: its ticket may land any moment.
  const [checking, setChecking] = useState(false);
  const ready = useQuery<Ready>({
    queryKey: readyKey(cardId),
    queryFn: async () => {
      const r = await apiFetch(`/api/release/ticket?cardId=${cardId}`, { identityToken });
      if (!r.ok) throw new Error(`ticket ${r.status}`);
      return ((await r.json()) as { ready: Ready }).ready;
    },
    enabled: !!identityToken,
    // Read once (a reload restores a waiting ticket), then poll only while a ticket waits or a check is under way.
    refetchInterval: (q) => (q.state.data || checking ? POLL_MS : false),
  });
  const [ended, setEnded] = useState(false);
  const [seen, setSeen] = useState<Ready>(null);
  const [cancelledId, setCancelledId] = useState<string | null>(null);
  const data = ready.data ?? null;
  // Adjusted while rendering (not in an effect): a ticket that was waiting and still valid, and that the holder didn't
  // cancel, disappeared on its own.
  if (data?.id !== seen?.id) {
    setSeen(data);
    if (data) setEnded(false);
    else if (seen && Number(seen.expiresAt) > now && seen.id !== cancelledId) setEnded(true);
  }
  // The card may have just been released: refresh everything but this ticket.
  useEffect(() => {
    if (ended) void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "release-ready" });
  }, [ended, queryClient]);
  const stage = collectStage(data, now, ended);
  const onReady = (r: ReleaseReady) => {
    setEnded(false);
    queryClient.setQueryData<Ready>(readyKey(cardId), () => ({ id: r.ticketId, expiresAt: r.expiresAt }));
    notify({ title: "Passport verified", body: "Show this screen to the vendor at the counter.", tone: "good", icon: <BadgeCheckIcon /> });
  };
  const cancel = async () => {
    const r = await apiFetch(`/api/release/ticket?cardId=${cardId}`, { method: "DELETE", identityToken }).catch(() => null);
    if (!r?.ok) return void notify({ title: "Couldn't cancel", body: "Try again in a moment.", tone: "shu", icon: <XIcon /> });
    if (data) setCancelledId(data.id);
    queryClient.setQueryData<Ready>(readyKey(cardId), null);
    notify({ title: "Collection cancelled", body: "The vendor can no longer pick up this check.", tone: "neutral", icon: <XIcon /> });
  };
  const dismiss = () => {
    setEnded(false);
    if (data) void cancel();
    else queryClient.setQueryData<Ready>(readyKey(cardId), null);
  };
  return { stage, onReady, cancel, dismiss, setChecking };
}

/** The refusal sentence for the owner's check; ALREADY_BOUND names the wallet their Passport already collects for. */
export function releaseRefusal(code: string, details?: Record<string, unknown>): string {
  if (code === "ALREADY_BOUND" && typeof details?.boundTo === "string") {
    return `Your Passport is linked to ${shortAddress(details.boundTo)}. Collect from that wallet, or move the card to it first.`;
  }
  return worldIdErrorMessage(code);
}

/** "Collect at the counter": the explainer sheet and the Passport check, in the owner's own session. */
export function CollectButton({ cardId, me, onReady, onOpenChange, className, label = "Collect at the counter" }: {
  cardId: bigint;
  me: `0x${string}`;
  onReady: (r: ReleaseReady) => void;
  /** The check sheet opened or closed (useCollect polls while it is open). */
  onOpenChange?: (open: boolean) => void;
  className?: string;
  label?: string;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  return (
    <>
      <Button variant="secondary" size="md" className={className} onClick={() => setOpen(true)}>
        <PackageIcon aria-hidden />{label}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="mx-auto max-w-lg rounded-t-3xl border-border bg-surface p-6">
          <SheetHeader className="p-0">
            <SheetTitle className="font-display text-[22px] text-text">Collect at the counter</SheetTitle>
            <SheetDescription className="text-[14px] text-text-2">
              At the Kura counter in Tokyo, verify with your Passport in World App. The vendor&apos;s station then picks up your check and hands you the card.
            </SheetDescription>
          </SheetHeader>
          <ul className="mt-4 flex list-disc flex-col gap-2 pl-5 text-[13px] text-text-2">
            <li>Only the card&apos;s owner can start this, from their own Kura app.</li>
            <li>The check stays valid for 15 minutes. You can cancel it any time before the handover.</li>
            <li>Once released, the card leaves the vault and its name is revoked. The token stays as a record.</li>
          </ul>
          <WorldIdGate
            action="release"
            signal={me}
            cardId={cardId}
            label="Verify with Passport"
            icon={<ScanFaceIcon aria-hidden />}
            variant="redeem"
            className="mt-6 h-11 w-full rounded-xl text-[15px]"
            onReleaseReady={(r) => {
              setOpen(false);
              onReady(r);
            }}
            onError={(code, details) => notify({ title: worldIdRefusalTitle(code), body: releaseRefusal(code, details), tone: "shu", icon: <XIcon /> })}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The counter match code, large and mono: the holder's screen and the vendor's station show the same one. */
export function MatchCode({ code, className }: { code: string; className?: string }) {
  return (
    <span aria-label={`Match code ${code.split("").join(" ")}`} className={cn("inline-flex gap-1.5 font-mono text-[34px] leading-none font-semibold tracking-[0.18em] text-text", className)}>
      {code}
    </span>
  );
}

/**
 * The owner's confirmation once verified: "Show this to the vendor · ready for 14:59" with the match code, or the check
 * that expired or ended on its own.
 */
export function CollectReady({ stage, cardName, onCancel, retry, className }: { stage: Exclude<CollectStage, { kind: "idle" }>; cardName: string; onCancel: () => void; retry?: React.ReactNode; className?: string }) {
  const ready = stage.kind === "ready";
  const title = ready ? "Show this to the vendor" : stage.kind === "ended" ? "Your check ended" : "Your check expired";
  const body =
    stage.kind === "ended"
      ? `It was used, refused or dropped because the card changed. If you haven't received ${cardName}, verify again at the counter.`
      : `Checks last 15 minutes. Verify again at the counter to collect ${cardName}.`;
  return (
    <section
      aria-live="polite"
      className={cn("flex flex-col items-center gap-5 rounded-3xl border p-7 text-center", ready ? "border-good/40 bg-good-soft" : "border-border bg-surface", className)}
    >
      <span className={cn("flex size-16 items-center justify-center rounded-full border-2 [&_svg]:size-8", ready ? "border-good text-good" : "border-border text-text-2")}>
        {ready ? <BadgeCheckIcon aria-hidden strokeWidth={1.75} /> : <TimerOffIcon aria-hidden />}
      </span>
      <div className="flex flex-col gap-1.5">
        <h2 className="font-display text-[24px] font-semibold text-text">{title}</h2>
        <p className="text-[14px] text-text-2">
          {ready ? (
            <>
              {cardName} · <span className="font-mono text-text">ready for {mmss(stage.secondsLeft)}</span>
            </>
          ) : (
            body
          )}
        </p>
      </div>
      {ready && (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-bg/60 px-6 py-4">
          <span className="text-[12px] tracking-[0.5px] text-muted-foreground uppercase">Match code</span>
          <MatchCode code={stage.code} />
        </div>
      )}
      {ready && <p className="max-w-[26rem] text-[13px] text-text-2">The vendor&apos;s station shows the same code. They confirm the handover there and give you the card.</p>}
      <div className="flex w-full flex-col gap-2.5 sm:w-auto sm:flex-row">
        {!ready && retry}
        <Button variant="secondary" size="md" onClick={onCancel}>
          {ready ? <><XIcon aria-hidden />Cancel</> : <><RotateCcwIcon aria-hidden />Dismiss</>}
        </Button>
      </div>
    </section>
  );
}
