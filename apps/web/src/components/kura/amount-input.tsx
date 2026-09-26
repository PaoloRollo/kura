import * as React from "react";
import { cn } from "@/lib/utils";

export type AmountInputProps = Omit<React.ComponentProps<"input">, "size"> & {
  label?: React.ReactNode;
  unit?: React.ReactNode;
  hint?: React.ReactNode;
  /** Classes for the unit (e.g. a mono suffix that sits right after the value). */
  unitClassName?: string;
  /** Pushed to the end of the field (a status icon). */
  trailing?: React.ReactNode;
  /** Border colour for a validated value: good, or shu for an error. */
  tone?: "default" | "good" | "shu";
  /** Classes for the hint line. */
  hintClassName?: string;
};

/** Input/Amount: label, mono value with a unit, and a hint underneath. */
export function AmountInput({ label, unit = "USDC", hint, unitClassName, trailing, tone = "default", hintClassName, className, id, ...props }: AmountInputProps) {
  const autoId = React.useId();
  const inputId = id ?? autoId;
  return (
    <div data-slot="amount-input" className={cn("flex w-full flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={inputId} className="text-[12px] text-text-2">
          {label}
        </label>
      )}
      <div
        className={cn(
          "flex items-center justify-between gap-3 rounded-lg border bg-bg px-3.5 py-[13px] transition-colors",
          tone === "good" ? "border-good" : tone === "shu" ? "border-shu" : "border-border focus-within:border-shu",
        )}
      >
        <input
          id={inputId}
          inputMode="decimal"
          autoComplete="off"
          className="w-full min-w-0 bg-transparent font-mono text-[18px] text-text outline-none placeholder:text-muted-foreground"
          {...props}
        />
        {unit && <span className={cn("shrink-0 text-[12px] text-muted-foreground", unitClassName)}>{unit}</span>}
        {trailing && <span className="ml-auto flex shrink-0 items-center">{trailing}</span>}
      </div>
      {hint && <p className={cn("text-[11px] text-muted-foreground", hintClassName)}>{hint}</p>}
    </div>
  );
}
