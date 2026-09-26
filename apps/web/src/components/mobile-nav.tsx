"use client";

import type * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeftIcon, Share2Icon } from "lucide-react";
import { notify } from "@/components/kura";
import { canGoBack } from "@/lib/nav-history";
import { cn } from "@/lib/utils";

/**
 * The mobile detail screens' 42px "Nav" row (yV8eD, sWbGq): back chevron, title, action. Back goes through the
 * router when the visit has in-app history, else to /app (a deep link has nothing inside Kura to go back to).
 */
export function MobileNav({ title, action, fallback = "/app", className }: {
  title?: React.ReactNode;
  /** The right-hand action; defaults to sharing the page link. */
  action?: React.ReactNode;
  fallback?: string;
  className?: string;
}) {
  const router = useRouter();
  function back(e: React.MouseEvent) {
    if (!canGoBack()) return; // follow the link to `fallback`
    e.preventDefault();
    router.back();
  }
  return (
    <div className={cn("flex h-[42px] items-center gap-3 md:hidden", className)}>
      <Link href={fallback} onClick={back} aria-label="Back" className="-ml-1.5 flex size-8 items-center justify-center rounded-md text-text hover:bg-surface-2">
        <ChevronLeftIcon aria-hidden className="size-5" />
      </Link>
      <span className="min-w-0 flex-1 truncate text-[16px] font-semibold text-text">{title}</span>
      {action ?? <ShareButton />}
    </div>
  );
}

function ShareButton() {
  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ url });
      else {
        await navigator.clipboard.writeText(url);
        notify({ title: "Link copied", tone: "good" });
      }
    } catch {
      // Dismissed share sheet or a blocked clipboard: nothing to do.
    }
  }
  return (
    <button type="button" onClick={share} aria-label="Share" className="flex size-8 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text">
      <Share2Icon aria-hidden className="size-[18px]" />
    </button>
  );
}
