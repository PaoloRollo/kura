"use client";

import type * as React from "react";
import Link from "next/link";
import { CircleDollarSignIcon, UserIcon } from "lucide-react";
import { BarChip, EnsName, TabBar, TopBar } from "@/components/kura";
import { NAV } from "@/components/site-header";
import { HandlesFixture } from "@/hooks/use-handles";
import { cn } from "@/lib/utils";
import { PREVIEW_HANDLES } from "./catalog";

const TABS = [...NAV.collector.slice(0, 3), { href: "/app/profile", label: "Profile", icon: UserIcon }];

/**
 * The collector shell for dev previews: the top bar (hidden on mobile on tab screens, as in the app), the preview
 * state links, and the mobile tab bar; `detail` drops the tab bar like a detail screen.
 */
export function PreviewShell({ base, states, state, path, detail = false, children }: {
  base: string;
  states: readonly string[];
  state: string;
  /** The app path the nav highlights. */
  path: string;
  detail?: boolean;
  children: React.ReactNode;
}) {
  return (
    <HandlesFixture.Provider value={PREVIEW_HANDLES}>
      <div className="min-h-screen">
        <TopBar
          className="max-md:hidden"
          homeHref="/app"
          nav={NAV.collector}
          pathname={path}
          exactHrefs={["/app"]}
          right={
            <>
              <BarChip icon={CircleDollarSignIcon} className="hidden sm:inline-flex">248.50 USDC</BarChip>
              <span className="inline-flex h-9 items-center rounded-md border border-border px-3"><EnsName name="paolo.kura.eth" copyable={false} /></span>
            </>
          }
        />
        <nav aria-label="Preview states" data-preview-nav className="flex flex-wrap gap-2 border-b border-border px-4 py-2 lg:px-12">
          {states.map((s) => (
            <Link key={s} href={`${base}?state=${s}`} className={cn("rounded-full px-2.5 py-1 text-[12px]", s === state ? "bg-surface-2 text-text" : "text-muted-foreground")}>{s}</Link>
          ))}
        </nav>
        <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">{children}</main>
        {!detail && <TabBar nav={TABS} pathname={path} exactHrefs={["/app"]} />}
      </div>
    </HandlesFixture.Provider>
  );
}
