import type * as React from "react";
import Link from "next/link";
import { TimerIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CardArt } from "./card-art";
import { Pill, type PillTone } from "./pill";

export type AuctionCardProps = Omit<React.ComponentProps<"article">, "children"> & {
  image: string;
  name: string;
  /** Set code and condition, e.g. "LEA · NM". */
  set: string;
  /** Formatted clearing price per shard, e.g. "$1,712". */
  clearingPrice: string;
  /** Clearing vs market, in percent; positive is a premium. */
  premium?: number;
  /** Time left, e.g. "04:12" (a string or a ticking <Countdown>). */
  timeLeft: React.ReactNode;
  /** Auction progress 0..1 (time elapsed). */
  progress: number;
  /** Footnote under the bar, e.g. "3 of 16 shards for sale · 62% of time elapsed". */
  footnote?: React.ReactNode;
  status?: PillTone;
  /** The pill's text (lib/card-status), e.g. "Ended · sold"; the tone's default label when absent. */
  statusLabel?: string;
  href?: string;
};

/** Auction card: art, name/set, status pill, clearing price, premium, time left and progress. Props only. */
export function AuctionCard({
  image,
  name,
  set,
  clearingPrice,
  premium,
  timeLeft,
  progress,
  footnote,
  status = "live",
  statusLabel,
  href,
  className,
  ...props
}: AuctionCardProps) {
  const p = Math.min(1, Math.max(0, progress));
  const body = (
    <>
      <div className="relative flex h-[260px] items-center justify-center bg-surface-2">
        <CardArt src={image} alt={name} className="h-[223px] w-auto" />
        {/* Capped to the art area so a long label ("Redeemable") truncates instead of running over a narrow card. */}
        <Pill tone={status} className="absolute top-3 left-3 max-w-[calc(100%-1.5rem)] truncate">{statusLabel}</Pill>
      </div>
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-text">{name}</h3>
            <p className="text-[12px] text-muted-foreground">{set}</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-surface-2 px-2 py-1 font-mono text-[12px] text-shu">
            <TimerIcon aria-hidden className="size-3" />
            <span aria-label="time left">{timeLeft}</span>
          </span>
        </div>
        <div className="mt-1 flex items-end justify-between gap-3">
          <div>
            <div className="text-[11px] text-muted-foreground">Clearing / shard</div>
            <div className="font-mono text-[20px] text-text">{clearingPrice}</div>
          </div>
          {premium != null && (
            <span className={cn("font-mono text-[12px]", premium >= 0 ? "text-s1-fg" : "text-shu")}>
              {premium >= 0 ? "+" : ""}
              {premium.toFixed(1)}%
            </span>
          )}
        </div>
        <div className="h-1 w-full rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)} aria-label="Auction progress">
          <div className="h-full rounded-full bg-s1" style={{ width: `${p * 100}%` }} />
        </div>
        {footnote && <p className="text-[11px] text-text-2">{footnote}</p>}
      </div>
    </>
  );
  return (
    <article
      data-slot="auction-card"
      className={cn("overflow-hidden rounded-2xl border border-border bg-surface transition-colors has-[a:hover]:border-text-2/40", className)}
      {...props}
    >
      {href ? (
        <Link href={href} className="block outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          {body}
        </Link>
      ) : (
        body
      )}
    </article>
  );
}
