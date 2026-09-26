import Link from "next/link";
import { ArrowRightIcon, BoxIcon, LayersIcon, ScanFaceIcon, ScanLineIcon, StoreIcon } from "lucide-react";
import { HeroCards } from "@/components/hero-cards";
import { BuiltOn, LandingFooter, LandingTopBar } from "@/components/landing";
import { Button } from "@/components/ui/button";

const STEPS = [
  {
    n: "01",
    title: "Scan",
    icon: ScanLineIcon,
    body: "The shop scans the card with a webcam. Scryfall confirms the printing and the owner gets a twin with an ENS name.",
    proof: "black-lotus-lea-1.kura.eth",
  },
  {
    n: "02",
    title: "Shard",
    icon: LayersIcon,
    body: "The owner splits it into 16 to 512 shards and opens a Uniswap continuous clearing auction for some of them.",
    proof: "16 shards · 3 for sale",
  },
  {
    n: "03",
    title: "Bid",
    icon: ScanFaceIcon,
    body: "Verified humans bid a budget and a max price. Everyone pays the same clearing price. The shop earns a fee.",
    proof: "one human, one wallet",
  },
  {
    n: "04",
    title: "Redeem",
    icon: BoxIcon,
    body: "Hold 80% and buy out the rest at the higher of market and clearing. Pass a Passport check and take the card.",
    proof: "81.3% ≥ 80%",
  },
] as const;

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <LandingTopBar pathname="/" />
      <main className="flex-1">
        <section className="relative overflow-hidden bg-[radial-gradient(ellipse_70%_80%_at_20%_60%,#1d1d20_0%,transparent_70%)]">
          <div className="mx-auto grid max-w-[1440px] items-center gap-10 px-4 pt-12 pb-16 sm:px-6 lg:grid-cols-[minmax(0,44rem)_minmax(0,1fr)] lg:gap-6 lg:px-16 lg:pt-24 lg:pb-28">
            <div className="relative z-10 flex flex-col items-start gap-6">
              <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-[12px] text-text-2">
                <span aria-hidden className="size-1.5 rounded-full bg-good" />
                Live on Sepolia · ETHGlobal Tokyo 2026
              </span>
              <h1 className="font-display text-[44px] leading-[1.02] font-semibold tracking-[-0.015em] text-text sm:text-[60px] lg:text-[76px]">
                Your cards stay in the vault. Their value moves.
              </h1>
              <p className="max-w-[37rem] text-[16px] leading-[1.6] text-text-2 sm:text-[18px]">
                Scan a Magic card at the counter, get its digital twin, split it into shards and sell them to verified humans. Hold 80% and you
                can buy out the rest and take the card home.
              </p>
              <div className="flex w-full flex-col gap-3 pt-2 sm:w-auto sm:flex-row">
                <Button asChild variant="primary" size="md" className="h-12 px-6 text-[15px]">
                  <Link href="/app">Explore live auctions<ArrowRightIcon /></Link>
                </Button>
                <Button asChild variant="secondary" size="md" className="h-12 px-6 text-[15px]">
                  <Link href="/vendor"><StoreIcon />I&apos;m a card shop</Link>
                </Button>
              </div>
            </div>
            <HeroCards />
          </div>
        </section>

        <section aria-labelledby="flow" className="mx-auto max-w-[1440px] px-4 pt-16 pb-20 sm:px-6 lg:px-16 lg:pt-24 lg:pb-[4.5rem]">
          <div className="flex flex-col gap-5 pb-10 lg:flex-row lg:items-end lg:justify-between">
            <h2 id="flow" className="max-w-[40rem] font-display text-[34px] leading-[1.08] font-semibold text-text sm:text-[44px]">
              From the counter to a thousand owners, and back.
            </h2>
            <p className="max-w-[24rem] text-[15px] leading-relaxed text-text-2">
              The physical card never leaves the vault until someone owns enough of it to take it home.
            </p>
          </div>
          <ol className="grid border-t border-border lg:grid-cols-4">
            {STEPS.map(({ n, title, icon: Icon, body, proof }, i) => (
              <li
                key={n}
                className={`flex flex-col gap-4 border-border py-8 lg:py-9 lg:pr-7 ${i > 0 ? "border-t lg:border-t-0 lg:border-l lg:pl-7" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[12px] text-shu">{n}</span>
                  <Icon aria-hidden className="size-5 text-text-2" strokeWidth={1.5} />
                </div>
                <h3 className="font-display text-[30px] font-semibold text-text">{title}</h3>
                <p className="text-[14px] leading-[1.55] text-text-2">{body}</p>
                <p className="mt-auto font-mono text-[12px] text-kin">{proof}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>
      <BuiltOn />
      <LandingFooter />
    </div>
  );
}
