import type * as React from "react";
import { ALPHA, usd } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";
import { ChartFrame } from "./chart-frame";

export type DemandLevel = { price: number; cumulative: number };

const MAX_ROWS = 8;

/** Up to eight levels, highest price first, windowed around the clearing level when there are more. */
export function demandRows(points: DemandLevel[], clearing: number | null): DemandLevel[] {
  const sorted = [...points].sort((a, b) => b.price - a.price);
  if (sorted.length <= MAX_ROWS) return sorted;
  const at = clearing == null ? -1 : sorted.findIndex((p) => p.price === clearing);
  if (at < 0) return sorted.slice(0, MAX_ROWS);
  const start = Math.min(Math.max(0, at - Math.floor(MAX_ROWS / 2)), sorted.length - MAX_ROWS);
  return sorted.slice(start, start + MAX_ROWS);
}

/**
 * Demand curve (LqnA2) as horizontal bars per price level: price, a 10px bar of the cumulative budget at that price or
 * higher (s1 at 50%; the clearing row solid s2), and the cumulative $ on the right. Plain divs.
 */
export function DemandBars({ points, clearing, forSale, footer }: {
  points: DemandLevel[];
  clearing: number | null;
  /** Shards for sale, for the "Clears at…" note. */
  forSale?: number;
  footer?: React.ReactNode;
}) {
  const rows = demandRows(points, clearing);
  const max = Math.max(1, ...rows.map((r) => r.cumulative));
  const note =
    footer ??
    (clearing != null && (forSale != null
      ? `Clears at ${usd(clearing)} where demand covers the ${forSale} shard${forSale === 1 ? "" : "s"} for sale.`
      : `Clears at ${usd(clearing)}.`));
  return (
    <ChartFrame
      title="Demand curve"
      subtitle="Cumulative budget by max price, clearing marked"
      table={{ columns: ["Max price", "Cumulative budget"], rows: rows.map((r) => [usd(r.price), usd(r.cumulative)]) }}
      footer={note || undefined}
    >
      {rows.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-muted-foreground">No bids yet</p>
      ) : (
        <ul className="flex flex-col gap-2.5" aria-label="Demand by price level">
          {rows.map((r) => {
            const isClearing = clearing != null && r.price === clearing;
            return (
              <li
                key={r.price}
                data-clearing={isClearing || undefined}
                title={`${usd(r.price)} or higher: ${usd(r.cumulative)}`}
                className="grid grid-cols-[52px_1fr_64px] items-center gap-3 font-mono text-[11px]"
              >
                <span className={cn(isClearing ? "text-s2" : "text-muted-foreground")}>{usd(r.price)}</span>
                <span className="h-2.5 min-w-0">
                  <span
                    className={cn("block h-full rounded-[3px]", isClearing && "bg-s2")}
                    style={{ width: `${(r.cumulative / max) * 100}%`, background: isClearing ? undefined : ALPHA.s1_50 }}
                  />
                </span>
                <span className="text-right text-text-2">{usd(r.cumulative)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </ChartFrame>
  );
}
