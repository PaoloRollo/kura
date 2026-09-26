import type * as React from "react";
import { StatTile } from "@/components/kura";
import { cn } from "@/lib/utils";

export type KpiTone = "default" | "pos" | "neg" | "kin";
export type Kpi = {
  label: string;
  /** The phone label when it differs ("Collectors" for "Verified collectors" in WABQw). */
  shortLabel?: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** Value colour: premium + is s1-fg, premium − is s2-fg, "eligible" is kin. */
  tone?: KpiTone;
  /** Leave the tile out of the phone layout (WABQw shows four of the six). */
  hideOnMobile?: boolean;
};

const TONE: Record<KpiTone, string> = { default: "text-text", pos: "text-s1-fg", neg: "text-s2-fg", kin: "text-kin" };

/**
 * The KPI row: one surface r16 strip with hairline dividers on desktop (LqnA2, Y1eNn), separate 2x2 cards on phones
 * (WABQw). Each cell is a bare `StatTile`.
 */
export function KpiStrip({ items, className }: { items: Kpi[]; className?: string }) {
  return (
    <div
      data-slot="kpi-strip"
      className={cn(
        "grid grid-cols-2 gap-2 lg:gap-0 lg:divide-x lg:divide-border lg:overflow-hidden lg:rounded-2xl lg:border lg:border-border lg:bg-surface",
        items.length >= 6 ? "lg:grid-cols-6" : items.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4",
        className,
      )}
    >
      {items.map((k) => (
        <StatTile
          key={k.label}
          bare
          data-tone={k.tone ?? "default"}
          className={cn(
            "rounded-2xl border border-border bg-surface p-4 lg:rounded-none lg:border-0 lg:bg-transparent lg:px-5 lg:py-[22px]",
            k.hideOnMobile && "max-lg:hidden",
          )}
          label={k.shortLabel ? <><span className="lg:hidden">{k.shortLabel}</span><span className="max-lg:hidden">{k.label}</span></> : k.label}
          value={<span className={cn("text-[22px] leading-tight lg:text-[26px]", TONE[k.tone ?? "default"])}>{k.value}</span>}
          sub={k.sub && <span className="max-lg:hidden">{k.sub}</span>}
        />
      ))}
    </div>
  );
}
