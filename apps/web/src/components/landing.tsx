import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TopBar, type NavItem } from "@/components/kura";

const LANDING_NAV: NavItem[] = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/app", label: "Vault" },
  { href: "/app/analytics", label: "Analytics", soon: true },
];

/** Landing top bar: wordmark, three links, Open app. No hairline, wider gutter than the app shells. */
export function LandingTopBar({ pathname }: { pathname: string }) {
  return (
    <TopBar
      bordered={false}
      nav={LANDING_NAV}
      pathname={pathname}
      exactHrefs={["/app"]}
      navAlign="end"
      wide
      right={
        <Button asChild variant="inverse" size="compact" className="h-10 px-4 text-[14px] font-semibold">
          <Link href="/app">Open app</Link>
        </Button>
      }
    />
  );
}

const SPONSORS = [
  ["Uniswap CCA", "auctions"],
  ["World ID", "humans"],
  ["ENSv2", "names"],
  ["Privy", "wallets"],
  ["Ponder", "indexing"],
  ["Scryfall", "card data"],
] as const;

/** "Built on" row: the protocols and services Kura runs on. */
export function BuiltOn() {
  return (
    <section aria-label="Built on" className="border-y border-border bg-surface">
      <div className="mx-auto grid max-w-[1440px] grid-cols-2 items-baseline gap-x-6 gap-y-5 px-4 py-7 sm:grid-cols-3 sm:px-6 lg:flex lg:justify-between lg:px-16">
        <span className="col-span-full text-[12px] text-muted-foreground lg:col-auto">Built on</span>
        {SPONSORS.map(([name, role]) => (
          <span key={name} className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="text-[17px] font-semibold text-text">{name}</span>
            <span className="text-[12px] text-muted-foreground">{role}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className="mx-auto flex w-full max-w-[1440px] flex-col gap-3 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-16">
      <p className="flex items-center gap-2.5 text-[13px] text-text-2">
        <span lang="ja" aria-hidden className="font-display text-[22px] text-shu">蔵</span>
        Kura · a storehouse for the cards you love
      </p>
      <p className="text-[12px] text-muted-foreground">Sepolia testnet. Card data and images from Scryfall. Not affiliated with Wizards of the Coast.</p>
    </footer>
  );
}
