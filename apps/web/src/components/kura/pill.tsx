import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const pillVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-[5px] text-[12px] leading-none font-semibold whitespace-nowrap",
  {
    variants: {
      tone: {
        live: "bg-shu-soft text-shu",
        sharded: "bg-s1-soft text-s1-fg",
        redeemable: "bg-kin-soft text-kin",
        released: "bg-good-soft text-good-fg",
        neutral: "bg-surface-2 text-text-2",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type PillTone = NonNullable<VariantProps<typeof pillVariants>["tone"]>;

const LABELS: Record<PillTone, string> = {
  live: "Live",
  sharded: "Sharded",
  redeemable: "Redeemable",
  released: "Released",
  neutral: "Neutral",
};

export type PillProps = React.ComponentProps<"span"> &
  VariantProps<typeof pillVariants> & {
    /** Hide the leading status dot. */
    dot?: boolean;
  };

/** Status pill (Pill/Live, Pill/Sharded, Pill/Redeemable, Pill/Released, Pill/Neutral). */
export function Pill({ tone = "neutral", dot = true, className, children, ...props }: PillProps) {
  const t = tone ?? "neutral";
  return (
    <span data-slot="pill" data-tone={t} className={cn(pillVariants({ tone: t }), className)} {...props}>
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full bg-current", t === "live" && "animate-pulse")} />}
      {children ?? LABELS[t]}
    </span>
  );
}

export { pillVariants };
