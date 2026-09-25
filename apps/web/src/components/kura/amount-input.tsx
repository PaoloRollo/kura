import * as React from "react";
import { cn } from "@/lib/utils";

export type AmountInputProps = Omit<React.ComponentProps<"input">, "size"> & {
  label?: React.ReactNode;
  unit?: React.ReactNode;
  hint?: React.ReactNode;
};

/** Input/Amount: label, mono value with a unit, and a hint underneath. */
export function AmountInput({ label, unit = "USDC", hint, className, id, ...props }: AmountInputProps) {
  const autoId = React.useId();
  const inputId = id ?? autoId;
  return (
    <div data-slot="amount-input" className={cn("flex w-full flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={inputId} className="text-[12px] text-text-2">
          {label}
        </label>
      )}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg px-3.5 py-[13px] transition-colors focus-within:border-shu">
        <input
          id={inputId}
          inputMode="decimal"
          autoComplete="off"
          className="w-full min-w-0 bg-transparent font-mono text-[18px] text-text outline-none placeholder:text-muted-foreground"
          {...props}
        />
        {unit && <span className="shrink-0 text-[12px] text-muted-foreground">{unit}</span>}
      </div>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
