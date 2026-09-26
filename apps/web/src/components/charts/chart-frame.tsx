"use client";

import { useState } from "react";
import type * as React from "react";
import { cn } from "@/lib/utils";

export type Legend = { label: string; color: string };
export type ChartTable = { columns: string[]; rows: (string | number)[][] };

/** The "Table" view every chart offers (oezcX styling: 12px, hairline rows, mono numbers). */
export function ChartTableView({ table, caption }: { table: ChartTable; caption?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            {table.columns.map((c, j) => (
              <th key={c} scope="col" className={cn("py-2 pr-3 font-normal", j > 0 && "text-right")}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {r.map((v, j) => (
                <td key={j} className={cn("py-2 pr-3", j === 0 ? "text-text" : "text-right font-mono text-text-2")}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Chart panel from the analytics screens: surface, r16, padding 22; 15px title and 12px subtitle; on the right the
 * legend swatches (shown for two or more series) and a "Table" chip that swaps the plot for its table. The height comes
 * from the content. On phones the panel goes flush, as in WABQw. `bare` drops the panel everywhere (the Market map).
 */
export function ChartFrame({ title, subtitle, legend = [], aside, table, footer, bare = false, className, children }: {
  title: string;
  subtitle?: string;
  legend?: Legend[];
  /** Extra header content left of the Table chip (the treemap's gradient legend). */
  aside?: React.ReactNode;
  table: ChartTable;
  /** Notes under the plot: "Market $1,562.50 / shard, flat over the window". */
  footer?: React.ReactNode;
  bare?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section
      data-slot="chart-frame"
      aria-label={title}
      className={cn(
        "flex min-w-0 flex-col gap-4",
        !bare && "sm:rounded-2xl sm:border sm:border-border sm:bg-surface sm:p-[22px]",
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[15px] font-semibold text-text">{title}</h3>
          {subtitle && <p className="text-[12px] text-text-2 max-sm:hidden">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-3.5">
          {legend.length >= 2 && (
            <ul className="flex flex-wrap items-center gap-3.5 text-[11px] text-text-2" aria-label="Legend">
              {legend.map((l) => (
                <li key={l.label} className="flex items-center gap-1.5">
                  <span aria-hidden className="inline-block h-[3px] w-2.5 rounded-[2px]" style={{ background: l.color }} />
                  {l.label}
                </li>
              ))}
            </ul>
          )}
          {aside}
          <button
            type="button"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
            className="rounded-[6px] border border-border px-2 py-0.5 text-[12px] text-text-2 transition-colors hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {showTable ? "Chart" : "Table"}
          </button>
        </div>
      </header>
      {showTable ? <ChartTableView table={table} caption={title} /> : children}
      {footer && <div className="text-[11px] text-text-2">{footer}</div>}
    </section>
  );
}

/** A footer note with a series swatch: "— Market $1,562.50 / shard". */
export function SwatchNote({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="inline-block h-[3px] w-2.5 rounded-[2px]" style={{ background: color }} />
      {children}
    </span>
  );
}
