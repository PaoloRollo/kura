"use client";

import Link from "next/link";
import { CircleDollarSignIcon, LogInIcon, ShieldXIcon, StoreIcon } from "lucide-react";
import type { MatchCandidate } from "@/lib/card-match";
import type { Candidate } from "@/lib/scryfall";
import { BarChip, TopBar } from "@/components/kura";
import { GateCard } from "@/components/gate-card";
import { NAV } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { ScanStation, type StationSeed } from "@/components/vendor/scan-station";
import { cn } from "@/lib/utils";

const mox = (set: string, setName: string, num: string, usd: string): Candidate => ({
  scryfallId: `mox-${set}`,
  name: "Mox Sapphire",
  printedName: null,
  lang: "en",
  set,
  setName,
  collectorNumber: num,
  rarity: "rare",
  image: "/cards/mox-sapphire.webp",
  imageSmall: "/cards/mox-sapphire.webp",
  prices: { usd, usdFoil: null, eur: null },
  finishes: ["nonfoil"],
  slug: "mox-sapphire",
  setCode: set,
});
const PRINTINGS = [
  mox("lea", "Limited Edition Alpha", "265", "38400"),
  mox("leb", "Limited Edition Beta", "266", "22100"),
  mox("2ed", "Unlimited Edition", "265", "6850"),
  mox("vma", "Vintage Masters", "7", "3020"),
  mox("30a", "30th Anniversary Edition", "263", "410"),
];
const match: MatchCandidate = { ...PRINTINGS[0], score: 0.97, illustrationId: "mox", siblings: PRINTINGS.slice(0, 3) };

const SEEDS: Record<string, StationSeed> = {
  empty: { step: "capture" },
  details: { step: "review", capture: "/cards/mox-sapphire.webp", matches: [match], confident: true, chosen: PRINTINGS[0], owner: "0x4f2cA0b3aE1f3d7a0b6d2f0C1e4B5a6D7c8Ea81e" },
  search: { step: "search", capture: "/cards/mox-sapphire.webp", matches: [{ ...match, score: 0.41 }], confident: false, manual: "mox sapph", results: PRINTINGS },
  "minted-unavailable": {
    step: "minted",
    mintUnavailable: { hash: "0x3a1f9c2e7b0d4a6f8e1c5b9d2a7f0e3c6b8d1a4f7e0c3b6d9a2f5e8c1b4d9f2", reason: "The receipt has no CardMinted event from the vault." },
  },
  minted: {
    step: "minted",
    minted: { image: "/cards/mox-sapphire.webp", name: "Mox Sapphire", tokenId: "2", ensName: "mox-sapphire-lea-2.kura.eth", owner: "kenji.kura.eth", condition: "NM", language: "en", block: "7,412,901", set: "LEA · Limited Edition Alpha", url: "https://kuravault.xyz/app/cards/2" },
  },
};

export function StationPreview({ state, states }: { state: string; states: readonly string[] }) {
  const gate = state === "signin" || state === "denied";
  return (
    <div className="min-h-screen">
      <TopBar
        nav={gate ? [] : NAV.vendor}
        pathname="/vendor/scan"
        badge={gate ? "Vendor station" : undefined}
        right={
          gate ? null : (
            <>
              <BarChip icon={CircleDollarSignIcon} className="hidden lg:inline-flex">Fees 412.30 USDC</BarChip>
              <span className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 font-mono text-[13px] text-text">
                <span aria-hidden className="size-[18px] rounded-full bg-[linear-gradient(-135deg,var(--kura-s7)_15%,var(--kura-shu)_85%)]" />
                kura.eth <span className="hidden text-text-2 sm:inline">· vendor</span>
              </span>
            </>
          )
        }
      />
      <nav aria-label="Preview states" className="flex flex-wrap gap-2 border-b border-border px-4 py-2 lg:px-12" data-preview-nav>
        {states.map((s) => (
          <Link key={s} href={`/design/station?state=${s}`} className={cn("rounded-full px-2.5 py-1 text-[12px]", s === state ? "bg-surface-2 text-text" : "text-muted-foreground")}>
            {s}
          </Link>
        ))}
      </nav>
      <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">
        {state === "signin" ? (
          <GateCard icon={<StoreIcon />} title="Open the counter">
            <p className="max-w-[24rem] text-[14px] leading-relaxed text-text-2">Sign in with the vendor wallet to scan cards, mint digital twins and confirm handovers at the counter.</p>
            <Button variant="primary" size="md" className="mt-1 w-full"><LogInIcon />Sign in as vendor</Button>
            <span className="text-[12px] text-muted-foreground">Collectors, head to the app instead</span>
          </GateCard>
        ) : state === "denied" ? (
          <GateCard icon={<ShieldXIcon />} title="This wallet isn't the vault vendor" tone="warn">
            <p className="text-[14px] text-text-2">0x4f2c…a81e is signed in, but only the whitelisted vendor wallet can mint twins and hand cards over.</p>
          </GateCard>
        ) : (
          <ScanStation key={state} seed={SEEDS[state]} />
        )}
      </main>
    </div>
  );
}
