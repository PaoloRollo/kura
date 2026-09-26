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

/** JetBrains Mono's advance width, in em. */
const MONO_ADVANCE = 0.6;

/**
 * A text value's font size: the design's 22px (26px from lg) unless the text is too wide for its tile, then just small
 * enough to fit ("$101,180.16" in a phone's half-width card). `cqi` is relative to the tile (an inline-size container).
 */
export function fitFontSize(value: React.ReactNode): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const fit = Math.floor((96 / (MONO_ADVANCE * value.length)) * 10) / 10;
  return `min(var(--kpi-fs), ${fit}cqi)`;
}

/**
 * The KPI row: one surface r16 strip with hairline dividers on desktop (LqnA2, Y1eNn), separate 2x2 cards on phones
 * (WABQw). Each cell is a bare `StatTile`.
 */
export function KpiStrip({ items, className }: { items: Kpi[]; className?: string }) {
  return (
    <div
      data-slot="kpi-strip"
      className={cn(
        "grid grid-cols-2 gap-2 lg:gap-0 lg:overflow-hidden lg:rounded-2xl lg:border lg:border-border lg:bg-surface",
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
            "@container rounded-2xl border border-border bg-surface p-4 lg:rounded-none lg:border-0 lg:not-last:border-r lg:border-border lg:bg-transparent lg:px-5 lg:py-[22px]",
            k.hideOnMobile && "max-lg:hidden",
          )}
          label={k.shortLabel ? <><span className="lg:hidden">{k.shortLabel}</span><span className="max-lg:hidden">{k.label}</span></> : k.label}
          value={
            <span className={cn("text-[22px] leading-tight [--kpi-fs:22px] lg:text-[26px] lg:[--kpi-fs:26px]", TONE[k.tone ?? "default"])} style={{ fontSize: fitFontSize(k.value) }}>
              {k.value}
            </span>
          }
          sub={k.sub && <span className="max-lg:hidden">{k.sub}</span>}
        />
      ))}
    </div>
  );
}
