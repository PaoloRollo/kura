"use client";

import * as React from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type EnsNameProps = React.ComponentProps<"span"> & {
  /** The ENS name, or a shortened address when there is none. */
  name: string;
  /** Copied instead of `name` when set (e.g. the full address behind a short one). */
  copyValue?: string;
  avatar?: boolean;
  copyable?: boolean;
  /** Tailwind max-width class applied to the name for truncation. */
  maxWidthClassName?: string;
  tone?: "text" | "kin";
};

/** ENS name: gradient avatar, mono name that truncates, and a copy-to-clipboard button. */
export function EnsName({
  name,
  copyValue,
  avatar = true,
  copyable = true,
  maxWidthClassName = "max-w-[16rem]",
  tone = "text",
  className,
  ...props
}: EnsNameProps) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyValue ?? name);
      setCopied(true);
    } catch {
      // Clipboard can be blocked (insecure context, permissions); the name stays selectable.
    }
  }

  return (
    <span data-slot="ens-name" className={cn("inline-flex min-w-0 items-center gap-2", className)} {...props}>
      {avatar && (
        <span aria-hidden className="size-[18px] shrink-0 rounded-full bg-[linear-gradient(-135deg,var(--kura-s7)_15%,var(--kura-shu)_85%)]" />
      )}
      <span title={name} className={cn("truncate font-mono text-[13px]", tone === "kin" ? "text-kin" : "text-text", maxWidthClassName)}>
        {name}
      </span>
      {copyable && (
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : `Copy ${name}`}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {copied ? <CheckIcon className="size-3 text-good-fg" /> : <CopyIcon className="size-3" />}
        </button>
      )}
    </span>
  );
}
