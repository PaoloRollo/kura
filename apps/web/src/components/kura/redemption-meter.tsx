import type * as React from "react";
import { cn } from "@/lib/utils";

export type RedemptionMeterProps = React.ComponentProps<"div"> & {
  /** Share held, 0..1. */
  value: number;
  /** Buyout threshold, 0..1. Kura redeems at 80%. */
  threshold?: number;
  label?: React.ReactNode;
  /** Replaces the right-hand status text ("81.3% · eligible"). */
  status?: React.ReactNode;
  /** Replaces the fill's colour classes (the card page uses a kin→violet gradient). */
  fillClassName?: string;
};

/** Redemption meter: progress toward the 80% buyout threshold, with a marker at the threshold. */
export function RedemptionMeter({ value, threshold = 0.8, label = "Redemption", status, fillClassName, className, ...props }: RedemptionMeterProps) {
  const v = Math.min(1, Math.max(0, value));
  const eligible = v >= threshold;
  const pct = (v * 100).toFixed(1);
  const need = Math.round(threshold * 100);
  return (
    <div data-slot="redemption-meter" data-eligible={eligible || undefined} className={cn("flex w-full flex-col gap-1.5", className)} {...props}>
      <div className="flex items-start justify-between text-[12px]">
        <span className="text-text-2">{label}</span>
        <span className={eligible ? "text-kin" : "text-text-2"}>
          {status ?? <>{pct}% · {eligible ? "eligible" : `needs ${need}%`}</>}
        </span>
      </div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number(pct)}
        aria-label={typeof label === "string" ? label : "Redemption"}
        className="relative h-2 w-full rounded-xs bg-surface-2"
      >
        <div className={cn("absolute inset-y-0 left-0 rounded-xs", fillClassName ?? (eligible ? "bg-kin" : "bg-s1"))} style={{ width: `${v * 100}%` }} />
        <div aria-hidden className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-text" style={{ left: `${threshold * 100}%` }} />
      </div>
    </div>
  );
}
