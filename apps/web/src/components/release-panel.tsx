"use client";

import { LockIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The "Hand over" panel on the inventory (tM3Hy). Stub until Task 8 wires the Passport check and release. */
export function ReleasePanel({ cardId, name, holder, onClose }: { cardId: bigint; name: string; holder: string; onClose?: () => void }) {
  return (
    <section
      aria-label={`Hand over ${name}`}
      data-card-id={cardId.toString()}
      data-holder={holder}
      className="flex flex-col gap-5 rounded-2xl border border-kin/40 bg-surface p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-[24px] leading-tight font-semibold text-text">Hand over {name}</h2>
        {onClose && (
          <button type="button" aria-label="Close" onClick={onClose} className="text-muted-foreground hover:text-text">
            <XIcon className="size-5" />
          </button>
        )}
      </div>
      <p className="text-[14px] leading-relaxed text-text-2">The Passport check and on-chain handover open here.</p>
      <Button variant="disabled" size="md" className="w-full" aria-disabled>
        <LockIcon />Confirm handover
      </Button>
    </section>
  );
}
