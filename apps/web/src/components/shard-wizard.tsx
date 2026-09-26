"use client";

import type * as React from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRightIcon, CheckIcon, ChevronLeftIcon, ExternalLinkIcon, InfoIcon, Loader2Icon, XIcon } from "lucide-react";
import { AmountInput, Button, CardArt, Segmented } from "@/components/kura";
import { Slider } from "@/components/ui/slider";
import type { CardData } from "@/hooks/use-card";
import { identityOf } from "@/components/card-page-parts";
import { explorerAddress, explorerTx } from "@/lib/chain";
import { dateTime } from "@/lib/card-view";
import { money, shortAddress, shortHash } from "@/lib/format";
import {
  DEFAULT_DURATION,
  BLOCK_SECONDS,
  DURATIONS,
  MAX_SHARDS,
  MIN_SHARDS,
  SHARD_STEP,
  afterFee,
  autoTick,
  defaultPricing,
  durationText,
  estimatedEnd,
  formatUsdcInput,
  gridColumns,
  marketPrice,
  oneTick,
  parseUsdcInput,
  roundFloor,
  shardParamErrors,
  TICK_MISMATCH,
  type ShardCreated,
  type ShardField,
  type ShardParams,
} from "@/lib/shard-math";
import { cn } from "@/lib/utils";

export type WizardStep = 1 | 2 | 3;
/**
 * What the success state shows: the parameters that went through, the tx hash (none when a retry found it done), when,
 * and the auction it opened (`shardOutcome`): undefined while the receipt is being read, null if it couldn't be.
 */
export type ShardDone = { params: ShardParams; hash?: string; at: number; created?: ShardCreated | null };

/** The wizard step in the URL (`?step=`), so browser back goes back a step. */
export type StepNav = { step: WizardStep | null; go: (s: WizardStep) => void; replace: (s: WizardStep) => void; back: () => void };

const asStep = (v: string | null): WizardStep | null => (v === "1" ? 1 : v === "2" ? 2 : v === "3" ? 3 : null);

/** `?step=` through the Next router: Next pushes a history entry, back pops one. */
export function useUrlStepNav(): StepNav {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.toString();
  return useMemo(() => {
    const href = (s: WizardStep) => {
      const q = new URLSearchParams(query);
      q.set("step", String(s));
      return `${pathname}?${q}`;
    };
    return { step: asStep(new URLSearchParams(query).get("step")), go: (s) => router.push(href(s)), replace: (s) => router.replace(href(s)), back: () => router.back() };
  }, [router, pathname, query]);
}

/** "$1,200", "$12.50", "$9,360.039": whole dollars when exact, else cents, or every digit that carries value. */
export function price(x: bigint): string {
  if (x % 1_000_000n === 0n) return money(x, 0);
  const frac = (x % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return money(x, Math.max(2, frac.length));
}

/** Whether `me` may shard this card: it is whole and `me` holds the vault token (the vault's NotCardOwner check). */
export function canShard(c: CardData, me: string | null | undefined): boolean {
  return !!c.card && c.card.state === "whole" && !!me && c.card.ownerOf.toLowerCase() === me.toLowerCase();
}

// ---------------------------------------------------------------------------------------------------------------------
// Pieces

/** The wizard's Nav row (bWyqz): close on step 1, back on the others, the title and the "1 of 3" counter, then the bar. */
function WizardNav({ title, step, cardHref, onBack }: { title: string; step: WizardStep | null; cardHref: string; onBack: () => void }) {
  const icon = "-ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-text hover:bg-surface-2";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-[42px] items-center gap-3">
        {step == null || step === 1 ? (
          <Link href={cardHref} aria-label="Close" className={icon}><XIcon aria-hidden className="size-5" /></Link>
        ) : (
          <button type="button" onClick={onBack} aria-label="Back" className={icon}><ChevronLeftIcon aria-hidden className="size-5" /></button>
        )}
        <span className="min-w-0 flex-1 truncate text-[16px] font-semibold text-text">{title}</span>
        {step != null && <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{step} of 3</span>}
      </div>
      {step != null && (
        <div className="grid grid-cols-3 gap-1.5" aria-hidden>
          {[1, 2, 3].map((s) => <span key={s} className={cn("h-[3px] rounded-full", s <= step ? "bg-shu" : "bg-surface-2")} />)}
        </div>
      )}
    </div>
  );
}

/** The shadcn Slider in Kura colours: a shu range and a white thumb with a shu ring. */
function ShuSlider(props: React.ComponentProps<typeof Slider>) {
  return (
    <Slider
      {...props}
      className={cn(
        "py-2 [&_[data-slot=slider-range]]:bg-shu [&_[data-slot=slider-thumb]]:size-6 [&_[data-slot=slider-thumb]]:border-[3px] [&_[data-slot=slider-thumb]]:border-shu [&_[data-slot=slider-thumb]]:bg-text [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-track]]:bg-surface-2",
        props.className,
      )}
    />
  );
}

/** The card art under a grid of one cell per shard (bands above 64 shards): kept cells in s1, cells for sale in shu. */
export function ShardGrid({ image, name, total, forSale }: { image: string | null; name: string; total: number; forSale: number }) {
  const cols = gridColumns(total);
  const kept = total - forSale;
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-full max-w-[220px]">
        {image ? <CardArt src={image} alt={name} className="w-full" /> : <div className="aspect-[63/88] w-full rounded-[4.5%/3.3%] bg-surface-2" />}
        <div aria-hidden className="absolute inset-0 overflow-hidden rounded-[4.5%/3.3%]">
          {cols ? (
            <div className="grid size-full" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${total / cols}, minmax(0, 1fr))` }}>
              {Array.from({ length: total }, (_, i) => (
                <span key={i} data-cell={i >= kept ? "sale" : "keep"} className={cn("border-[0.5px] border-white/30", i >= kept ? "bg-shu/60" : "bg-s1/15")} />
              ))}
            </div>
          ) : (
            <div className="flex size-full flex-col">
              <span data-band="keep" className="bg-s1/15" style={{ flex: `${kept} 0 0%` }} />
              <span data-band="sale" className="border-t border-white/50 bg-shu/60" style={{ flex: `${forSale} 0 0%` }} />
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-5 text-[13px] text-text-2">
        <span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-[2px] bg-s1" />You keep {kept}</span>
        <span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-[2px] bg-shu" />For sale {forSale}</span>
      </div>
    </div>
  );
}

function Summary({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="grid grid-cols-3 gap-3 rounded-2xl border border-border bg-surface p-4">
      {items.map((it, i) => (
        <div key={it.label} className={cn("flex min-w-0 flex-col gap-1", i === 1 && "items-center text-center", i === 2 && "items-end text-right")}>
          <span className="text-[12px] text-text-2">{it.label}</span>
          <span className="max-w-full truncate font-mono text-[15px] text-text sm:text-[16px]">{it.value}</span>
        </div>
      ))}
    </div>
  );
}

const FieldError = ({ children }: { children?: string }) => (children ? <p role="alert" className="text-[12px] text-shu">{children}</p> : null);

/** The CTA row: pinned to the bottom of the screen on mobile (bWyqz), inline from `md` up. */
const Pinned = ({ children }: { children: React.ReactNode }) => (
  <>
    <div className="max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:border-t max-md:border-border max-md:bg-bg/95 max-md:px-4 max-md:pt-4 max-md:pb-[calc(1rem+env(safe-area-inset-bottom))] max-md:backdrop-blur md:pt-2">
      {children}
    </div>
    {/* Room under the content for the pinned row, so it never covers the last field. */}
    <div aria-hidden className="h-28 md:hidden" />
  </>
);

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0">
      <span className="shrink-0 text-[13px] text-text-2">{label}</span>
      <span className="min-w-0 text-right font-mono text-[12px] text-text sm:text-[13px]">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The wizard

export type ShardWizardProps = {
  c: CardData;
  me: string | null | undefined;
  /** The vault's live `feeBps()`; null while it loads. */
  feeBps: number | null;
  /** Unix seconds, for the end-date estimate. */
  now: number;
  cardHref: string;
  /** Where the step lives (`useUrlStepNav`). */
  nav: StepNav;
  /** The furthest step the form may show on load; a cold load of `?step=3` has no form state, so it starts at 1. */
  initialStep?: WizardStep;
  /** Previews: open on the success state. */
  initialDone?: ShardDone | null;
  /** Previews: a typed floor (shows its validation). */
  initialFloor?: string;
  /** The step-3 CTA (a TxStepper) for these parameters; `onDone` switches to the success state. */
  renderSubmit: (p: ShardParams, disabled: boolean, onDone: (done: ShardDone) => void) => React.ReactNode;
};

/** Shard a whole card (bWyqz, ITGkz, couMI): shards and for sale, then pricing, then duration and review. */
export function ShardWizard({ c, me, feeBps, now, cardHref, nav, initialStep = 1, initialDone = null, initialFloor, renderSubmit }: ShardWizardProps) {
  // The URL names the step; the form only shows steps it has reached (browser forward can't skip ahead of the state).
  const [reached, setReached] = useState<WizardStep>(initialStep);
  const step = Math.min(nav.step ?? initialStep, reached) as WizardStep;
  useEffect(() => {
    if (nav.step != null && nav.step !== step) nav.replace(step);
  }, [nav, step]);
  const next = (s: WizardStep) => {
    setReached((r) => (s > r ? s : r));
    nav.go(s);
  };
  // Which of floor and tick the user touched last: a floor off the tick is reported under that one.
  const [lastEdited, setLastEdited] = useState<"floor" | "tick">("floor");
  const [totalShards, setTotalShards] = useState(32);
  const [forSale, setForSale] = useState(8);
  // Floor and tick follow the market price until edited; an edited floor picks its own tick (autoTick) until that is edited too.
  const [floorText, setFloorText] = useState<string | null>(initialFloor ?? null);
  const [tickText, setTickText] = useState<string | null>(null);
  const [reserveText, setReserveText] = useState("0.00");
  const [duration, setDuration] = useState<number>(DEFAULT_DURATION);
  const [done, setDone] = useState<ShardDone | null>(initialDone);
  // Once the form has shown, it stays: the indexer flips the card to auctioning while the transaction is still being
  // confirmed, and a race with another sharder is the vault's to reject (WrongState, NotCardOwner).
  const eligible = canShard(c, me);
  const [opened, setOpened] = useState(eligible);
  if (eligible && !opened) setOpened(true);

  const identity = identityOf(c);
  const title = `Shard ${identity.name}`;
  if (done) return <ShardSuccess c={c} done={done} cardHref={cardHref} />;
  if (!opened) return <NotShardable c={c} title={title} cardHref={cardHref} />;

  // A zero price is no price: the defaults and the banner both fall back.
  const market = marketPrice(c.price);
  const d = defaultPricing(market != null ? c.price!.adjustedUsd : null, totalShards);
  const floor = floorText != null ? parseUsdcInput(floorText) : d.floorUsdcPerShard;
  // A typed floor picks its tick (autoTick), or keeps the 1% tick and asks to round the floor when nothing coarse divides it.
  const tick = tickText != null ? parseUsdcInput(tickText) : floorText != null && floor != null ? (autoTick(floor) ?? oneTick(floor)) : d.tickUsdcPerShard;
  const reserve = parseUsdcInput(reserveText || "0");
  const p: ShardParams = {
    totalShards,
    forSale,
    floorUsdcPerShard: floor ?? 0n,
    tickUsdcPerShard: tick ?? 0n,
    reserveUsdc: reserve ?? 0n,
    durationBlocks: duration,
  };
  const errors: Partial<Record<ShardField, string>> = shardParamErrors(p);
  if (floor == null) errors.floor = "Enter an amount in USDC, up to 6 decimals";
  if (tick == null) errors.tick = "Enter an amount in USDC, up to 6 decimals";
  if (reserve == null) errors.reserve = "Enter an amount in USDC, up to 6 decimals";
  const mismatch = errors.floor === TICK_MISMATCH && floor != null && tick != null && tick > 0n;
  if (mismatch && lastEdited === "tick") {
    errors.tick = errors.floor;
    delete errors.floor;
  }
  const rounded = mismatch ? roundFloor(floor!, tick!) : null;
  const roundTo = rounded != null && (
    <button
      type="button"
      className="w-fit rounded-md border border-shu/40 px-2.5 py-1 text-[12px] font-semibold text-shu hover:bg-shu-soft"
      onClick={() => {
        setFloorText(formatUsdcInput(rounded));
        setTickText(formatUsdcInput(tick!)); // keep this tick: the rounded floor sits on it
      }}
    >
      Round to {price(rounded)}
    </button>
  );
  const stepErrors = { 1: !!(errors.totalShards || errors.forSale), 2: !!(errors.floor || errors.tick || errors.reserve), 3: !!errors.duration };
  const disabledReason = stepErrors[1] ? "Fix the shard counts on step 1 first."
    : stepErrors[2] ? "Fix the floor, tick or reserve on step 2 first."
      : stepErrors[3] ? "Pick one of the listed auction lengths."
        : !me ? "Your wallet is still connecting." : null;

  const implied = p.floorUsdcPerShard * BigInt(totalShards);
  const maxRaise = p.floorUsdcPerShard * BigInt(forSale);
  const perShardMarket = market != null ? market / BigInt(totalShards) : null;
  const feePct = feeBps != null ? `${(feeBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%` : "…";
  const ends = estimatedEnd(now, duration);

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
      <WizardNav title={title} step={step} cardHref={cardHref} onBack={nav.back} />

      {step === 1 && (
        <>
          <ShardGrid image={identity.image} name={identity.name} total={totalShards} forSale={forSale} />
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between"><span className="text-[14px] text-text-2">Total shards</span><span className="font-mono text-[16px] text-text">{totalShards}</span></div>
            <ShuSlider
              aria-label="Total shards"
              min={MIN_SHARDS}
              max={MAX_SHARDS}
              step={SHARD_STEP}
              value={[totalShards]}
              onValueChange={([v]) => {
                setTotalShards(v);
                setForSale((f) => Math.min(f, v));
              }}
            />
            <div className="flex justify-between font-mono text-[11px] text-muted-foreground">{[16, 128, 256, 384, 512].map((v) => <span key={v}>{v}</span>)}</div>
            <FieldError>{errors.totalShards}</FieldError>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between"><span className="text-[14px] text-text-2">For sale</span><span className="font-mono text-[16px] text-text">{forSale} of {totalShards}</span></div>
            <ShuSlider aria-label="Shards for sale" min={1} max={totalShards} step={1} value={[forSale]} onValueChange={([v]) => setForSale(v)} />
            <FieldError>{errors.forSale}</FieldError>
          </div>
          <Summary
            items={[
              { label: "Market", value: market != null ? money(market, 0) : "n/a" },
              { label: "Per shard", value: perShardMarket != null ? price(perShardMarket) : "n/a" },
              { label: "Max raise", value: price(maxRaise) },
            ]}
          />
          <Pinned>
            <Button variant="primary" size="md" className="w-full" disabled={stepErrors[1]} onClick={() => next(2)}>
              Next: set floor price <ArrowRightIcon aria-hidden />
            </Button>
          </Pinned>
        </>
      )}

      {step === 2 && (
        <>
          <div className="flex items-center gap-4 rounded-2xl border border-border bg-surface p-4">
            {identity.image ? <CardArt src={identity.image} alt="" className="w-10 shrink-0 rounded-[3px]" /> : <div className="aspect-[63/88] w-10 shrink-0 rounded-[3px] bg-surface-2" />}
            {market != null ? (
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[15px] font-semibold text-text">Scryfall market {money(market, 0)}</span>
                <span className="font-mono text-[12px] text-text-2">÷ {totalShards} shards = {price(market / BigInt(totalShards))} per shard</span>
              </div>
            ) : (
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[15px] font-semibold text-text">No market price yet</span>
                <span className="text-[12px] text-text-2">Scryfall has no USD price for this printing. The floor starts at 1 USDC per shard.</span>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <AmountInput
              label="Floor price per shard"
              value={floorText ?? formatUsdcInput(d.floorUsdcPerShard)}
              onChange={(e) => {
                setFloorText(e.target.value);
                setLastEdited("floor");
              }}
              tone={errors.floor ? "shu" : "default"}
              aria-invalid={!!errors.floor}
              hint={market != null ? "Nobody can buy below this. Prefilled from the market price." : "Nobody can buy below this. Set it yourself: there's no market price to start from."}
            />
            <FieldError>{errors.floor}</FieldError>
            {errors.floor === TICK_MISMATCH && roundTo}
          </div>
          <div className="flex flex-col gap-1.5">
            <AmountInput
              label="Price tick"
              value={tickText ?? (tick != null ? formatUsdcInput(tick) : "")}
              onChange={(e) => {
                setTickText(e.target.value);
                setLastEdited("tick");
              }}
              tone={errors.tick ? "shu" : "default"}
              aria-invalid={!!errors.tick}
              hint="Bids move in steps of 1% of the floor."
            />
            <FieldError>{errors.tick}</FieldError>
            {errors.tick === TICK_MISMATCH && roundTo}
          </div>
          <div className="flex flex-col gap-1.5">
            <AmountInput
              label="Reserve (total, optional)"
              value={reserveText}
              onChange={(e) => setReserveText(e.target.value)}
              tone={errors.reserve ? "shu" : "default"}
              aria-invalid={!!errors.reserve}
              hint="If the auction raises less, it cancels, bidders are refunded and you keep every shard."
            />
            <FieldError>{errors.reserve}</FieldError>
          </div>
          <Summary
            items={[
              { label: "Implied value", value: price(implied) },
              { label: "Max raise at floor", value: price(maxRaise) },
              { label: "You receive", value: feeBps != null ? price(afterFee(maxRaise, feeBps)) : "…" },
            ]}
          />
          <p className="text-[12px] text-text-2">After the {feePct} vault fee. Clearing above the floor raises more.</p>
          <Pinned>
            <Button variant="primary" size="md" className="w-full" disabled={stepErrors[2]} onClick={() => next(3)}>
              Next: duration <ArrowRightIcon aria-hidden />
            </Button>
          </Pinned>
        </>
      )}

      {step === 3 && (
        <>
          <div className="flex flex-col gap-3">
            <span className="text-[13px] text-text-2">Auction length · 5 min is for demos</span>
            <Segmented
              label="Auction length"
              options={DURATIONS.map((o) => ({ value: String(o.blocks), label: o.label }))}
              value={String(duration)}
              onChange={(v) => setDuration(Number(v))}
              className="border-0 bg-transparent p-0 gap-2 [&>button]:h-11 [&>button]:rounded-xl [&>button]:border [&>button]:border-border [&>button]:bg-surface [&>button[aria-checked=true]]:border-shu [&>button[aria-checked=true]]:bg-shu-soft"
            />
            <FieldError>{errors.duration}</FieldError>
          </div>
          <div className="rounded-2xl border border-border bg-surface">
            <Row label="Card"><span className="break-all text-kin">{c.card!.ensName}</span></Row>
            <Row label="Shards">{totalShards} total · {forSale} for sale · {totalShards - forSale} kept</Row>
            <Row label="Floor · tick">{price(p.floorUsdcPerShard)} · {price(p.tickUsdcPerShard)}</Row>
            <Row label="Reserve">{p.reserveUsdc > 0n ? price(p.reserveUsdc) : "none"}</Row>
            <Row label="Ends">{dateTime(ends)} · {durationText(duration)} · {duration.toLocaleString("en-US")} blocks</Row>
            <Row label="Bidders">World ID verified only</Row>
            <Row label="Vault fee">{feePct} of proceeds</Row>
          </div>
          <p className="flex gap-3 px-1 text-[13px] text-text-2">
            <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            Your card moves into escrow until the auction settles. You can redeem it back once you hold 80% of the shards.
          </p>
          <Pinned>
            {renderSubmit(p, !!disabledReason, setDone)}
            {disabledReason && <p className="pt-2 text-center text-[12px] text-shu">{disabledReason}</p>}
          </Pinned>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// End states

/** Not the owner, or the card is not whole: say why, with a way back to the card. */
function NotShardable({ c, title, cardHref }: { c: CardData; title: string; cardHref: string }) {
  const state = c.card?.state;
  const reason =
    state === "auctioning" ? "This card is already up for auction."
      : state === "sharded" ? "This card is already sharded."
        : state === "released" ? "This card has left the vault."
          : "Only the card's owner can shard it.";
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
      <WizardNav title={title} step={null} cardHref={cardHref} onBack={() => {}} />
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-6">
        <h1 className="font-display text-[24px] font-semibold text-text">You can&apos;t shard this card</h1>
        <p className="text-[14px] text-text-2">{reason} Only a whole card in the vault can be sharded, by the wallet that owns it.</p>
        <Button asChild variant="secondary" size="md" className="mt-2 w-full sm:w-fit"><Link href={cardHref}>Back to the card</Link></Button>
      </div>
    </div>
  );
}

/** The confirmation state: the auction that just opened, its tx and the way on to it. */
function ShardSuccess({ c, done, cardHref }: { c: CardData; done: ShardDone; cardHref: string }) {
  const identity = identityOf(c);
  const { params: p, created } = done;
  const live = c.card?.state === "auctioning";
  // The tx: this run's hash, else (a retry found it done) the indexer's shard activity for this sharding.
  const indexed = created ? c.activities.find((a) => a.kind === "shard" && String((a.meta as { shardToken?: string } | null)?.shardToken ?? "").toLowerCase() === created.shardToken.toLowerCase()) : undefined;
  const hash = done.hash ?? created?.hash ?? indexed?.txHash;
  const reading = created === undefined;
  const addressLink = (a: string) => (
    <a href={explorerAddress(a)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-text-2 hover:text-text hover:underline">
      {shortAddress(a)}<ExternalLinkIcon aria-hidden className="size-3" />
    </a>
  );
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
      <WizardNav title="Auction opened" step={null} cardHref={cardHref} onBack={() => {}} />
      <div className="flex flex-col items-center gap-4 pt-2 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-good-soft text-good-fg"><CheckIcon aria-hidden className="size-7" strokeWidth={2.5} /></span>
        <h1 className="font-display text-[28px] leading-tight font-semibold text-text">Your auction is live</h1>
        <p className="max-w-[420px] text-[14px] text-text-2">
          {identity.name} is now {p.totalShards} shards. {p.forSale} are up for auction and {p.totalShards - p.forSale} are in your wallet.
        </p>
      </div>
      <ShardGrid image={identity.image} name={identity.name} total={p.totalShards} forSale={p.forSale} />
      <div className="rounded-2xl border border-border bg-surface">
        <Row label="Floor · tick">{price(p.floorUsdcPerShard)} · {price(p.tickUsdcPerShard)}</Row>
        <Row label="Reserve">{p.reserveUsdc > 0n ? price(p.reserveUsdc) : "none"}</Row>
        <Row label="Auction">{created ? addressLink(created.auction) : reading ? "reading the receipt…" : "see the card page"}</Row>
        <Row label="Shard token">{created ? addressLink(created.shardToken) : reading ? "…" : "see the card page"}</Row>
        <Row label="Ends">
          {created
            ? `${dateTime(done.at + Number(created.endBlock - created.refBlock) * BLOCK_SECONDS)} · block ${created.endBlock.toLocaleString("en-US")}`
            : `${dateTime(estimatedEnd(done.at, p.durationBlocks))} · ${durationText(p.durationBlocks)}`}
        </Row>
        <Row label="Transaction">
          {hash ? (
            <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-text-2 hover:text-text hover:underline">
              {shortHash(hash)}<ExternalLinkIcon aria-hidden className="size-3" />
            </a>
          ) : "confirmed"}
        </Row>
        <Row label="Status">
          <span aria-live="polite" className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-sans text-[12px]", live ? "bg-good-soft text-good-fg" : "bg-surface-2 text-text-2")}>
            {live ? <CheckIcon aria-hidden className="size-3" /> : <Loader2Icon aria-hidden className="size-3 animate-spin" />}
            {live ? "Live" : "Indexing…"}
          </span>
        </Row>
      </div>
      <div className="flex flex-col gap-2.5">
        <Button asChild variant="primary" size="md" className="w-full"><Link href={`${cardHref}?tab=auction`}>Open the auction</Link></Button>
        <Button asChild variant="secondary" size="md" className="w-full"><Link href={cardHref}>Back to the card</Link></Button>
      </div>
    </div>
  );
}
