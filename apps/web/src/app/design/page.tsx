import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowRightIcon } from "lucide-react";
import {
  AmountInput,
  AuctionCard,
  Button,
  EnsName,
  FilterChip,
  Pill,
  RedemptionMeter,
  SearchInput,
  StatTile,
} from "@/components/kura";
import { ToastDemo } from "./toast-demo";

export const metadata: Metadata = { title: "Kura · Components" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3.5">
      <h2 className="text-[11px] tracking-[1px] text-muted-foreground uppercase">{title}</h2>
      <div className="flex flex-wrap items-start gap-6">{children}</div>
    </section>
  );
}

/** Dev-only replica of the pen.dev Components sheet (v839x): every Kura component in every variant. */
export default function DesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-9 px-4 py-12 sm:px-12">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[36px] font-semibold text-text">Components</h1>
        <p className="text-[13px] text-text-2">
          Source of truth for the shadcn theme. Tokens: bg #111112 · surface #18181A · surface-2 #222225 · border #2C2C30 · shu #E8552F · kin #D4B06A · Fraunces / Inter Tight / JetBrains Mono
        </p>
      </header>

      <Section title="Buttons">
        <Button variant="primary" size="md"><ArrowRightIcon />Primary</Button>
        <Button variant="secondary" size="md"><ArrowRightIcon />Secondary</Button>
        <Button variant="redeem" size="md"><ArrowRightIcon />Redeem</Button>
        <Button variant="inverse" size="md"><ArrowRightIcon />Inverse</Button>
        <Button variant="disabled" size="md" aria-disabled><ArrowRightIcon />Disabled</Button>
        <Button variant="primary" size="md" disabled><ArrowRightIcon />Primary, disabled</Button>
        <Button variant="secondary" size="compact">Compact</Button>
      </Section>

      <Section title="Pills">
        <Pill tone="live" />
        <Pill tone="sharded" />
        <Pill tone="redeemable" />
        <Pill tone="released" />
        <Pill tone="neutral" />
      </Section>

      <Section title="Inputs">
        <AmountInput className="w-[320px]" label="Spend up to" defaultValue="2,000.00" unit="USDC" hint="Whatever isn't used is refunded." />
        <SearchInput boxClassName="w-[320px]" />
        <FilterChip label="Condition" value="Any" />
        <FilterChip label="Set" value="LEA, LEB" active />
        <SearchInput boxClassName="w-[320px]" kbd="/" placeholder="Search with a shortcut" />
      </Section>

      <Section title="Data">
        <StatTile className="w-[220px]" label="Clearing price" value="$1,712" sub="per shard · floor $1,560" />
        <EnsName name="paolo.kura.eth" />
        <EnsName name="black-lotus-lea-1.kura.eth" tone="kin" avatar={false} maxWidthClassName="max-w-[10rem]" />
        <RedemptionMeter className="w-[300px]" value={0.813} />
        <RedemptionMeter className="w-[300px]" value={0.469} />
      </Section>

      <Section title="Cards and feedback">
        <AuctionCard
          className="w-[300px]"
          image="/cards/black-lotus.webp"
          name="Black Lotus"
          set="LEA · NM"
          clearingPrice="$1,712"
          premium={9.6}
          timeLeft="04:12"
          progress={0.62}
          footnote="3 of 16 shards for sale · 62% of time elapsed"
        />
        <AuctionCard
          className="w-[300px]"
          image="/cards/ancestral-recall.webp"
          name="Ancestral Recall"
          set="LEA · LP"
          clearingPrice="$662"
          premium={-7.2}
          timeLeft="18:40"
          progress={0.35}
          status="sharded"
          footnote="8 of 32 shards for sale · 35% of time elapsed"
        />
        <div className="flex flex-col gap-4">
          <ToastDemo />
        </div>
      </Section>
    </main>
  );
}
