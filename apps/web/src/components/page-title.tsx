import type * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/** The 390 tab screens' title row (Z6BlV0, YH4Ft): vermilion 蔵, the page name in Fraunces, an optional action. */
export function MobilePageTitle({ title, right, className }: { title: string; right?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 md:hidden", className)}>
      <h1 className="flex items-center gap-2.5 font-display text-[24px] font-semibold text-text">
        <Link href="/app" aria-label="Kura home" lang="ja" className="text-shu">蔵</Link>
        {title}
      </h1>
      {right}
    </div>
  );
}

/** The gradient avatar the mobile screens show top right, linking to the profile. */
export function AvatarLink({ href = "/app/profile", className }: { href?: string; className?: string }) {
  return (
    <Link href={href} aria-label="Profile" className={cn("size-9 shrink-0 rounded-full bg-[linear-gradient(-135deg,var(--kura-s7)_15%,var(--kura-shu)_85%)]", className)} />
  );
}
