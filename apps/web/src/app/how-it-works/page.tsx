import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, ChartColumnIcon, GavelIcon, LayersIcon, PackageOpenIcon, XIcon } from "lucide-react";
import { CardArt } from "@/components/kura";
import { BuiltOn, LandingFooter, LandingTopBar } from "@/components/landing";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "How shards work · Kura",
  description: "A card in the vault becomes 16 to 512 tokens. What you own, how you buy, what it's worth and how it ends.",
};

const POINTS = [
  {
    icon: LayersIcon,
    title: "What you own",
    body: "A shard is an ERC-20 token for a fixed slice of one physical card. 1 of 16 shards is 6.25% of that card.",
  },
  {
    icon: GavelIcon,
    title: "How you buy",
    body: "In an auction you set a budget and the most you'd pay per shard. Everyone pays the same final price. Unspent USDC comes back.",
  },
  {
    icon: ChartColumnIcon,
    title: "What it's worth",
    body: "The auction clearing price, compared live with the Scryfall market price divided by the shard count.",
  },
  {
    icon: PackageOpenIcon,
    title: "How it ends",
    body: "Whoever reaches 80% can buy out the rest at the higher of market and clearing price, and collect the card with a Passport check.",
  },
] as const;

// The whole life of a card, in order.
const LIFECYCLE = [
  ["Mint", "The shop scans the card; its twin is minted with an ENS name and the card goes into the vault."],
  ["Shard", "The owner splits the twin into 16 to 512 ERC-20 shards."],
  ["CCA auction", "Some shards sell in a Uniswap continuous clearing auction, to World ID verified humans only."],
  ["80% buyout", "A holder of 80% pays out the rest at the higher of market and clearing price."],
  ["Release", "The card leaves the vault at the counter. Its ENS name is revoked and the token stays as a record."],
] as const;

export default function HowItWorksPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <LandingTopBar pathname="/how-it-works" />
      <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-16 px-4 pt-6 pb-20 sm:px-6 lg:px-16 lg:pt-12">
        <article className="relative mx-auto w-full max-w-[62.5rem] rounded-[28px] border border-border bg-surface p-6 sm:p-10">
          <Link
            href="/"
            aria-label="Back to the landing page"
            className="absolute top-6 right-6 inline-flex size-9 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text sm:top-10 sm:right-10"
          >
            <XIcon className="size-5" />
          </Link>
          <header className="flex flex-col gap-2 pr-12">
            <h1 className="font-display text-[34px] leading-tight font-semibold text-text sm:text-[40px]">How shards work</h1>
            <p className="text-[15px] text-text-2">A card in the vault becomes 16 to 512 tokens. Here&apos;s what that means for you.</p>
          </header>

          <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {POINTS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex flex-col gap-3 rounded-2xl bg-[#1e1e21] p-5">
                <Icon aria-hidden className="size-[22px] text-shu" strokeWidth={1.75} />
                <h2 className="text-[16px] font-semibold text-text">{title}</h2>
                <p className="text-[13px] leading-[1.55] text-text-2">{body}</p>
              </li>
            ))}
          </ul>

          <div className="mt-7 flex flex-col gap-5 rounded-2xl border border-border p-6 sm:flex-row sm:items-center">
            <CardArt src="/cards/black-lotus.webp" alt="Black Lotus" className="w-16 shrink-0 shadow-none" />
            <div className="flex flex-col gap-1.5">
              <h2 className="text-[15px] font-semibold text-text">Example: Black Lotus in 16 shards</h2>
              <p className="text-[13px] leading-[1.55] text-text-2">
                Market $25,000 → about $1,562 per shard. The owner kept 13 and sold 3 at $1,712 each. At 81% they can buy out the last 3 for $5,136
                plus the 2.5% vault fee, and take the card home.
              </p>
            </div>
          </div>

          <footer className="mt-7 flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[12px] text-muted-foreground">Test network only. Card data from Scryfall.</p>
            <Button asChild variant="primary" size="md" className="w-full sm:w-auto">
              <Link href="/app">See live auctions<ArrowRightIcon /></Link>
            </Button>
          </footer>
        </article>

        <section aria-labelledby="life" className="mx-auto w-full max-w-[62.5rem]">
          <h2 id="life" className="font-display text-[28px] font-semibold text-text">The life of a card</h2>
          <ol className="mt-6 grid border-t border-border md:grid-cols-5">
            {LIFECYCLE.map(([name, body], i) => (
              <li key={name} className={`flex flex-col gap-2 py-6 md:pr-5 ${i > 0 ? "border-t border-border md:border-t-0 md:border-l md:pl-5" : ""}`}>
                <span className="font-mono text-[12px] text-shu">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="text-[15px] font-semibold text-text">{name}</h3>
                <p className="text-[13px] leading-[1.55] text-text-2">{body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button asChild variant="primary" size="md"><Link href="/app">Explore live auctions<ArrowRightIcon /></Link></Button>
            <Button asChild variant="secondary" size="md"><Link href="/vendor">Open the vendor station</Link></Button>
          </div>
        </section>
      </main>
      <BuiltOn />
      <LandingFooter />
    </div>
  );
}
