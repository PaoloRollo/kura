"use client";

import { useState } from "react";
import Link from "next/link";
import { CircleDollarSignIcon, UserIcon } from "lucide-react";
import { BarChip, Button, EnsName, TabBar, TopBar } from "@/components/kura";
import { ClaimHandleView, type CheckState } from "@/components/claim-handle";
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

export function CollectorPreview({ state, states }: { state: string; states: readonly string[] }) {
  const signedIn = state !== "login";
  return (
    <div className="min-h-screen">
      <TopBar
        nav={signedIn ? NAV.collector : []}
        pathname="/app"
        exactHrefs={["/app"]}
        right={
          signedIn ? (
            <>
              <BarChip icon={CircleDollarSignIcon} className="hidden sm:inline-flex">248.50 USDC</BarChip>
              <span className="inline-flex h-9 items-center rounded-md border border-border px-3">
                <EnsName name={state === "shell" ? "paolo.kura.eth" : "0x4f2c…a81e"} copyable={false} />
              </span>
            </>
          ) : (
            <Button variant="inverse" size="compact">Log in</Button>
          )
        }
      />
      <nav aria-label="Preview states" className="flex flex-wrap gap-2 border-b border-border px-4 py-2 lg:px-12" data-preview-nav>
        {states.map((s) => (
          <Link key={s} href={`/design/collector?state=${s}`} className={cn("rounded-full px-2.5 py-1 text-[12px]", s === state ? "bg-surface-2 text-text" : "text-muted-foreground")}>
            {s}
          </Link>
        ))}
      </nav>
      <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">
        {state === "login" ? (
          <CollectorLogin onLogin={() => {}} />
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
