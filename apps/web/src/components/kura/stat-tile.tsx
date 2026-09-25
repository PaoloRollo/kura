import type * as React from "react";
import { cn } from "@/lib/utils";

export type StatTileProps = React.ComponentProps<"div"> & {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** Drop the surface and border, for stats laid out inline (the station's "Minted today" row). */
  bare?: boolean;
};

/** Stat tile: label, mono value, sub line. */
export function StatTile({ label, value, sub, bare = false, className, ...props }: StatTileProps) {
  return (
    <div
      data-slot="stat-tile"
      className={cn("flex min-w-0 flex-col gap-1.5", !bare && "rounded-xl border border-border bg-surface p-[18px]", className)}
      {...props}
    >
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className={cn("truncate font-mono text-text", bare ? "text-[16px]" : "text-[26px] leading-tight")}>{value}</div>
      {sub && <div className="text-[11px] text-text-2">{sub}</div>}
    </div>
  );
}
