"use client";

import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = { value: T; label?: string };

/** Segmented control (station Details: condition, language, finish). A radio group underneath. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
  label,
  columns,
  className,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  label: string;
  /** Grid columns; defaults to one row with every option. */
  columns?: number;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn("grid gap-1 rounded-lg border border-border bg-surface p-1", disabled && "opacity-40", className)}
      style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-8 rounded-sm text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              checked ? "bg-surface-2 font-semibold text-text" : "text-muted-foreground hover:text-text-2",
            )}
          >
            {o.label ?? o.value}
          </button>
        );
      })}
    </div>
  );
}
