import { ListOrderedIcon } from "lucide-react";
import type * as React from "react";
import Link from "next/link";
import { CardArt } from "@/components/kura";
import { cn } from "@/lib/utils";
import { ChartFrame } from "./chart-frame";

export type LeaderboardTone = "pos" | "neg" | "neutral";
export type LeaderboardRow = {
  rank: number; thumb?: string; label: string; value: string; tone?: LeaderboardTone; href?: string;
  /** The value is from a live auction's latest clearing, not a settled one: a muted "live" before it. */
  live?: boolean;
};

const TONE: Record<LeaderboardTone, string> = { pos: "text-s1-fg", neg: "text-s2-fg", neutral: "text-muted-foreground" };

/** "Richest premiums" (Y1eNn, WABQw): rank (muted, hidden on phones), a 24px card thumb, the name, the value toned. */
export function Leaderboard({ title, subtitle, rows, valueLabel = "Value" }: {
  title: string;
  subtitle?: string;
  rows: LeaderboardRow[];
  valueLabel?: string;
}) {
  return (
    <ChartFrame chartIcon={ListOrderedIcon} title={title} subtitle={subtitle} table={{ columns: ["Card", valueLabel], rows: rows.map((r) => [`${r.rank}. ${r.label}`, r.live ? `${r.value} (live)` : r.value]) }}>
      <ol className="flex flex-col gap-3">
        {rows.map((r) => {
          const body: React.ReactNode = (
            <>
              <span className="w-4 shrink-0 text-[12px] text-muted-foreground max-sm:hidden">{r.rank}</span>
              {r.thumb ? (
                <CardArt src={r.thumb} alt="" className="w-6 shrink-0 shadow-none" />
              ) : (
                <span aria-hidden className="aspect-[63/88] w-6 shrink-0 rounded-[2px] bg-surface-2" />
              )}
              <span className="min-w-0 flex-1 truncate text-[13px] text-text">{r.label}</span>
              {r.live && <span className="shrink-0 text-[11px] text-muted-foreground">live</span>}
              <span className={cn("font-mono text-[12px]", TONE[r.tone ?? "neutral"])}>{r.value}</span>
            </>
          );
          return (
            <li key={`${r.rank}-${r.label}`}>
              {r.href ? (
                <Link href={r.href} className="-mx-1.5 flex items-center gap-3 rounded-md px-1.5 py-0.5 hover:bg-surface-2">{body}</Link>
              ) : (
                <div className="flex items-center gap-3 py-0.5">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </ChartFrame>
  );
}
