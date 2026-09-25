"use client";

import { useState } from "react";
import Link from "next/link";
import { CircleDollarSignIcon, UserIcon } from "lucide-react";
import { BarChip, Button, EnsName, TabBar, TopBar } from "@/components/kura";
import { ClaimedView, ClaimHandleView, type CheckState } from "@/components/claim-handle";
import { CollectorLogin } from "@/components/collector-login";
import { HandleBanner } from "@/components/handle-banner";
import { NAV } from "@/components/site-header";
import { cn } from "@/lib/utils";

const CHECKS: Record<string, { label: string; check: CheckState }> = {
  available: { label: "paolo", check: { available: true } },
  checking: { label: "paolo", check: { checking: true } },
  taken: { label: "kenji", check: { available: false, reason: "TAKEN" } },
  reserved: { label: "vault", check: { available: false, reason: "RESERVED" } },
  invalid: { label: "pa", check: { available: false, reason: "INVALID" } },
  named: { label: "paolo", check: { available: false, reason: "ALREADY_NAMED", label: "kenji" } },
  empty: { label: "", check: null },
};

const TABS = [...NAV.collector.slice(0, 3), { href: "/app/profile", label: "Profile", icon: UserIcon }];

function Claim({ initial }: { initial: { label: string; check: CheckState } }) {
  const [label, setLabel] = useState(initial.label);
  const ok = !!initial.check && "available" in initial.check && initial.check.available;
  return (
    <ClaimHandleView
      label={label}
      onLabel={setLabel}
      check={initial.check}
      holding={initial.label === "paolo" ? { card: "Black Lotus", shards: "13", pct: "81.3%" } : null}
      fallbackName="0x4f2c…a81e"
      hints={[{ label: "vault", note: "reserved" }, { label: "kenji", note: "taken" }]}
      cta={<Button variant="primary" size="md" className="w-full" disabled={!ok}>Claim {label || "your handle"}{label ? ".kura.eth" : ""}</Button>}
    />
  );
}

function StateNav({ state, states }: { state: string; states: readonly string[] }) {
  return (
    <nav aria-label="Preview states" className="flex flex-wrap gap-2 border-b border-border px-4 py-2 lg:px-12" data-preview-nav>
      {states.map((s) => (
        <Link key={s} href={`/design/collector?state=${s}`} className={cn("rounded-full px-2.5 py-1 text-[12px]", s === state ? "bg-surface-2 text-text" : "text-muted-foreground")}>
          {s}
        </Link>
      ))}
    </nav>
  );
}

export function CollectorPreview({ state, states }: { state: string; states: readonly string[] }) {
  // Login is full-bleed (no top bar); Claim handle drops the top bar on mobile, like /app/onboarding.
  if (state === "login") {
    return (
      <div className="relative min-h-screen">
        <div className="absolute inset-x-0 top-0 z-10 bg-bg/80"><StateNav state={state} states={states} /></div>
        <CollectorLogin onLogin={() => {}} />
      </div>
    );
  }
  const claim = state !== "shell"; // Claim handle and its success state
  return (
    <div className="min-h-screen">
      <TopBar
        className={claim ? "max-md:hidden" : undefined}
        nav={NAV.collector}
        pathname="/app"
        exactHrefs={["/app"]}
        right={
          <>
            <BarChip icon={CircleDollarSignIcon} className="hidden sm:inline-flex">248.50 USDC</BarChip>
            {/* The shell fixture is a wallet without a handle yet (it shows the banner), so the chip is the short address. */}
            <span className="inline-flex h-9 items-center rounded-md border border-border px-3">
              <EnsName name="0x4f2c…a81e" copyable={false} />
            </span>
          </>
        }
      />
      <StateNav state={state} states={states} />
      <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">
        {state === "claimed" || state === "claimed-live" ? (
          <ClaimedView label="paolo" hash="0x5e2f9a1c3b7d4e6f8a0b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f2a4b6c8e0c0a" live={state === "claimed-live"} />
        ) : state === "shell" ? (
          <>
            <HandleBanner forceShow />
            <h1 className="font-display text-[28px] font-semibold text-text md:text-[32px]">Live auctions</h1>
          </>
        ) : (
          <Claim key={state} initial={CHECKS[state]} />
        )}
      </main>
      {state === "shell" && <TabBar nav={TABS} pathname="/app" exactHrefs={["/app"]} />}
    </div>
  );
}
