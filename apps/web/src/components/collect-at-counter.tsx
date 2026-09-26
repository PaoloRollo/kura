"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheckIcon, PackageIcon, RotateCcwIcon, ScanFaceIcon, TimerOffIcon, XIcon } from "lucide-react";
import { Button, notify } from "@/components/kura";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { WorldIdGate, worldIdErrorMessage, worldIdRefusalTitle } from "@/components/world-id-gate";
import { apiFetch, useKuraUser } from "@/hooks/use-kura-user";
import { useNow } from "@/hooks/use-now";
import type { ReleaseReady } from "@/hooks/use-world-id-ticket";
import { collectStage, mmss, type CollectStage } from "@/lib/release";
import { cn } from "@/lib/utils";

type Ready = { expiresAt: string } | null;
const readyKey = (cardId: bigint) => ["release-ready", cardId.toString()];

/**
 * The owner's side of a handover: their waiting release ticket for the card (restored on reload), the Passport check
 * that creates it, and cancelling it.
 */
export function useCollect(cardId: bigint) {
  const { identityToken } = useKuraUser();
  const queryClient = useQueryClient();
  const now = useNow(1000);
  const ready = useQuery<Ready>({
    queryKey: readyKey(cardId),
    queryFn: async () => {
      const r = await apiFetch(`/api/release/ticket?cardId=${cardId}`, { identityToken });
      if (!r.ok) throw new Error(`ticket ${r.status}`);
      return ((await r.json()) as { ready: Ready }).ready;
    },
    enabled: !!identityToken,
  });
  const stage = collectStage(ready.data ?? null, now);
  const onReady = (r: ReleaseReady) => {
    queryClient.setQueryData<Ready>(readyKey(cardId), () => ({ expiresAt: r.expiresAt }));
    notify({ title: "Passport verified", body: "Show this screen to the vendor at the counter.", tone: "good", icon: <BadgeCheckIcon /> });
  };
  const cancel = async () => {
    const r = await apiFetch(`/api/release/ticket?cardId=${cardId}`, { method: "DELETE", identityToken }).catch(() => null);
    if (!r?.ok) return void notify({ title: "Couldn't cancel", body: "Try again in a moment.", tone: "shu", icon: <XIcon /> });
    queryClient.setQueryData<Ready>(readyKey(cardId), null);
    notify({ title: "Collection cancelled", body: "The vendor can no longer pick up this check.", tone: "neutral", icon: <XIcon /> });
  };
  return { stage, onReady, cancel };
}

/** "Collect at the counter": the explainer sheet and the Passport check, in the owner's own session. */
export function CollectButton({ cardId, me, onReady, className, label = "Collect at the counter" }: { cardId: bigint; me: `0x${string}`; onReady: (r: ReleaseReady) => void; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
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
            onError={(code) => notify({ title: worldIdRefusalTitle(code), body: worldIdErrorMessage(code), tone: "shu", icon: <XIcon /> })}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The owner's confirmation once verified: "Show this to the vendor · ready for 14:59", or the expired check. */
export function CollectReady({ stage, cardName, onCancel, retry, className }: { stage: Exclude<CollectStage, { kind: "idle" }>; cardName: string; onCancel: () => void; retry?: React.ReactNode; className?: string }) {
  const ready = stage.kind === "ready";
  return (
    <section
      aria-live="polite"
      className={cn("flex flex-col items-center gap-5 rounded-3xl border p-7 text-center", ready ? "border-good/40 bg-good-soft" : "border-border bg-surface", className)}
    >
      <span className={cn("flex size-16 items-center justify-center rounded-full border-2 [&_svg]:size-8", ready ? "border-good text-good" : "border-border text-text-2")}>
        {ready ? <BadgeCheckIcon aria-hidden strokeWidth={1.75} /> : <TimerOffIcon aria-hidden />}
      </span>
      <div className="flex flex-col gap-1.5">
        <h2 className="font-display text-[24px] font-semibold text-text">{ready ? "Show this to the vendor" : "Your check expired"}</h2>
        <p className="text-[14px] text-text-2">
          {ready ? (
            <>
              {cardName} · <span className="font-mono text-text">ready for {mmss(stage.secondsLeft)}</span>
            </>
          ) : (
            `Checks last 15 minutes. Verify again at the counter to collect ${cardName}.`
          )}
        </p>
      </div>
      {ready && <p className="max-w-[26rem] text-[13px] text-text-2">Your Passport check is waiting at the counter. The vendor confirms the handover on their station and gives you the card.</p>}
      <div className="flex w-full flex-col gap-2.5 sm:w-auto sm:flex-row">
        {!ready && retry}
        <Button variant="secondary" size="md" onClick={onCancel}>
          {ready ? <><XIcon aria-hidden />Cancel</> : <><RotateCcwIcon aria-hidden />Dismiss</>}
        </Button>
      </div>
    </section>
  );
}
