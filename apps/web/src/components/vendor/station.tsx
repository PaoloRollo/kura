import type * as React from "react";
import { CheckIcon, ScanEyeIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const STATION_STEPS = ["Capture", "Match", "Details", "Owner", "Mint"] as const;

/** Stepper above the stage: done steps get a green check, the current one a shu ring. */
export function StationStepper({ current }: { current: number }) {
  return (
    <ol aria-label="Scan progress" className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {STATION_STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            {i > 0 && <span aria-hidden className="hidden h-px w-4 bg-border sm:block" />}
            <span
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-full border py-1 pr-3 pl-1.5 text-[13px]",
                active ? "border-shu bg-shu-soft text-text" : "border-border text-text-2",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full text-[11px] font-semibold",
                  done ? "bg-good text-white" : active ? "bg-shu text-white" : "bg-surface-2 text-text",
                )}
              >
                {done ? <CheckIcon className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Corner brackets drawn around the card guide. Kin once a card is recognised, grey while waiting. */
export function Brackets({ tone = "idle", className }: { tone?: "idle" | "found"; className?: string }) {
  const c = tone === "found" ? "border-kin" : "border-text-2/70";
  const base = cn("absolute size-8 md:size-9", c);
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0", className)}>
      <span className={cn(base, "top-0 left-0 border-t-2 border-l-2")} />
      <span className={cn(base, "top-0 right-0 border-t-2 border-r-2")} />
      <span className={cn(base, "bottom-0 left-0 border-b-2 border-l-2")} />
      <span className={cn(base, "right-0 bottom-0 border-r-2 border-b-2")} />
    </div>
  );
}

/** The dark camera stage: rounded panel, LIVE chip on the right, an optional status chip on the left. */
export function ScanStage({
  children,
  chip,
  live = true,
  className,
}: {
  children: React.ReactNode;
  /** Top-left status: recognised card, confidence, loading. */
  chip?: React.ReactNode;
  live?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-[26rem] items-center justify-center overflow-hidden rounded-3xl border border-border bg-[radial-gradient(ellipse_at_50%_45%,#232326_0%,#141415_70%)] md:min-h-[min(46rem,72vh)]",
        className,
      )}
    >
      {chip && <div className="absolute top-4 left-4 z-10 max-w-[calc(100%-7rem)] md:top-6 md:left-6">{chip}</div>}
      {live && (
        <span className="absolute top-5 right-5 z-10 inline-flex items-center gap-1.5 rounded-full bg-bg/70 px-2.5 py-1 text-[11px] font-semibold tracking-[1px] text-text md:top-7 md:right-7">
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-shu" />LIVE
        </span>
      )}
      {children}
    </div>
  );
}

/** Status chip on the stage: "Mox Sapphire · Limited Edition Alpha  97%". */
export function StageChip({ children, score, tone = "good" }: { children: React.ReactNode; score?: number; tone?: "good" | "warn" }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-bg/80 px-3.5 py-2 text-[13px] text-text backdrop-blur">
      <ScanEyeIcon aria-hidden className={cn("size-4 shrink-0", tone === "good" ? "text-kin" : "text-shu")} />
      <span className="truncate">{children}</span>
      {score != null && (
        <span className={cn("shrink-0 font-mono text-[11px]", tone === "good" ? "text-good-fg" : "text-shu")}>{Math.round(score * 100)}%</span>
      )}
    </span>
  );
}

/** Section heading in the station's right column: "Scryfall match ........ 3 printings". */
export function PanelHeading({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-[14px] font-semibold text-text">{children}</h2>
      {aside && <span className="text-[12px] text-muted-foreground">{aside}</span>}
    </div>
  );
}

/** Candidate printing row: thumbnail, name, mono SET · #n · LANG, price. */
export function CandidateRow({
  image,
  name,
  meta,
  price,
  note,
  selected,
  onPick,
}: {
  image: string;
  name: string;
  meta: string;
  price?: string;
  note?: string;
  selected?: boolean;
  onPick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-3.5 rounded-xl border bg-surface p-3 text-left transition-colors outline-none hover:bg-surface-2 focus-visible:ring-3 focus-visible:ring-ring/50",
        selected ? "border-kin bg-surface-2" : "border-border",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- remote Scryfall thumbnails, not optimised */}
      <img src={image} alt="" className="h-[52px] w-[37px] shrink-0 rounded-[3px] object-cover" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-medium text-text">{name}</span>
        <span className="truncate font-mono text-[11px] text-text-2">{meta}</span>
        {note && <span className="truncate text-[11px] text-muted-foreground">{note}</span>}
      </span>
      {price && <span className={cn("shrink-0 font-mono text-[13px]", selected ? "text-kin" : "text-text-2")}>{price}</span>}
    </button>
  );
}

/** Info row on the empty station ("We read the name and set"). */
export function HowRow({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <span className="mt-0.5 text-text-2 [&_svg]:size-4">{icon}</span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[14px] font-semibold text-text">{title}</span>
        <span className="text-[12px] text-text-2">{body}</span>
      </span>
    </div>
  );
}
