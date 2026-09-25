import type * as React from "react";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type FilterChipProps = Omit<React.ComponentProps<"button">, "value"> & {
  label: React.ReactNode;
  value?: React.ReactNode;
  /** A filter is applied: shu outline and a clear icon instead of the caret. */
  active?: boolean;
};

/** Filter chip: "Condition  Any ⌄". Active chips (a value is set) turn shu. */
export function FilterChip({ label, value = "Any", active = false, className, ...props }: FilterChipProps) {
  return (
    <button
      type="button"
      data-slot="filter-chip"
      data-active={active || undefined}
      className={cn(
        "inline-flex h-fit shrink-0 items-center gap-1.5 rounded-full border px-3 py-2 text-[12px] leading-none whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        active ? "border-shu bg-shu-soft" : "border-border bg-surface hover:bg-surface-2",
        className,
      )}
      {...props}
    >
      <span className={active ? "text-text-2" : "text-muted-foreground"}>{label}</span>
      <span className={cn("font-semibold", active ? "text-text" : "text-text-2")}>{value}</span>
      {active ? (
        <XIcon aria-hidden className="size-3 text-shu" />
      ) : (
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
      )}
    </button>
  );
}
