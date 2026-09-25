import type * as React from "react";
import { cn } from "@/lib/utils";

/** Centred panel for the shell states (Vendor sign in V9zhY, Not authorised viPYt). */
export function GateCard({
  icon,
  title,
  children,
  tone = "default",
  className,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  children: React.ReactNode;
  /** "warn" draws the shu-tinted border of the Not authorised card. */
  tone?: "default" | "warn";
  className?: string;
}) {
  return (
    <div className="flex min-h-[calc(100dvh-10rem)] items-center justify-center py-10">
      <section
        className={cn(
          "flex w-full max-w-[460px] flex-col items-center gap-4 rounded-3xl border bg-surface px-6 py-9 text-center sm:px-9",
          tone === "warn" ? "border-shu/35" : "border-border",
          className,
        )}
      >
        <span className="flex size-16 items-center justify-center rounded-xl bg-shu-soft text-shu [&_svg]:size-6">{icon}</span>
        <h1 className="font-display text-[28px] leading-tight font-semibold text-balance text-text">{title}</h1>
        {children}
      </section>
    </div>
  );
}
