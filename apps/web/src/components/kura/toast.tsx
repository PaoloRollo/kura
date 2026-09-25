"use client";

import type * as React from "react";
import { GavelIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Tone = "shu" | "kin" | "good" | "neutral";
const TONES: Record<Tone, string> = {
  shu: "bg-shu-soft text-shu",
  kin: "bg-kin-soft text-kin",
  good: "bg-good-soft text-good-fg",
  neutral: "bg-bg text-text-2",
};

export type KuraToastProps = {
  title: React.ReactNode;
  body?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: Tone;
  action?: { label: string; onClick: () => void };
  className?: string;
};

/** The Toast from the Components sheet: icon box, title, body and a text action. */
export function KuraToast({ title, body, icon = <GavelIcon />, tone = "shu", action, className }: KuraToastProps) {
  return (
    <div
      data-slot="kura-toast"
      className={cn(
        "flex w-full max-w-[380px] items-center gap-3 rounded-xl border border-border bg-surface-2 p-3.5 shadow-toast",
        className,
      )}
    >
      <span className={cn("flex size-[34px] shrink-0 items-center justify-center rounded-md [&_svg]:size-4", TONES[tone])}>{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-[13px] font-semibold text-text">{title}</div>
        {body && <div className="text-[12px] text-text-2">{body}</div>}
      </div>
      {action && (
        <button type="button" onClick={action.onClick} className="shrink-0 text-[12px] font-semibold text-shu hover:underline">
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Shows a KuraToast through sonner. */
export function notify(props: KuraToastProps & { duration?: number }) {
  const { duration, action, ...rest } = props;
  return toast.custom(
    (id) => (
      <KuraToast
        {...rest}
        action={action && { label: action.label, onClick: () => { action.onClick(); toast.dismiss(id); } }}
      />
    ),
    { duration },
  );
}
