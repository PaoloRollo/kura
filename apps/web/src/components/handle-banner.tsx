"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { XIcon } from "lucide-react";
import { addresses } from "@/lib/chain";

const KEY = "kura:handle-banner-dismissed";
const listeners = new Set<() => void>();

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function dismiss() {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Storage can be blocked; the banner then comes back on the next visit.
  }
  listeners.forEach((l) => l());
}

/** "Claim your handle": a dismissible nudge towards /app/onboarding for a wallet without a Kura handle. Never redirects. */
export function HandleBanner({ forceShow = false }: { forceShow?: boolean }) {
  const dismissed = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readDismissed,
    () => true,
  );
  if (dismissed && !forceShow) return null;
  return (
    <div role="status" className="mb-6 flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <span lang="ja" aria-hidden className="font-display text-[20px] leading-none text-shu">蔵</span>
      <p className="min-w-0 flex-1 text-[13px] text-text-2">
        Pick a name for the vault. Your handle shows on every card you hold and every bid.{" "}
        <Link href="/app/onboarding" className="font-medium text-shu hover:underline">
          Claim your .{addresses.ensParentLabel}.eth handle
        </Link>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-text"
      >
        <XIcon className="size-4" />
      </button>
    </div>
  );
}
