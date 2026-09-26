"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  BadgeCheckIcon, CheckCheckIcon, CoinsIcon, DownloadIcon, ExternalLinkIcon, GavelIcon, KeyRoundIcon, LayersIcon, PackageOpenIcon, SendIcon, Undo2Icon, type LucideIcon,
} from "lucide-react";
import type { Address } from "viem";
import { abi, q96ToUsdcPerShard } from "@kura/shared";
import { identityOf } from "@/components/card-page-view";
import { Credit } from "@/components/card-header";
import { Button, CardArt, EnsName, RedemptionMeter } from "@/components/kura";
import { MobileNav } from "@/components/mobile-nav";
import { SendShardsSheet } from "@/components/send-shards";
import { useVaultIo } from "@/components/vault-io";
import type { CardData } from "@/hooks/use-card";
import { shardsShort } from "@/lib/buyout";
import { ago, canRedeem, shareOf } from "@/lib/card-view";
import { explorerAddress } from "@/lib/chain";
import { clearingOf, languageName } from "@/lib/explore";
import { money, shardsFixed, shortAddress } from "@/lib/format";
import { metaTrait } from "@/lib/meta";
import { historyRows, isSeller, type HistoryRow } from "@/lib/portfolio";
import { costBasis, referencePrice, unrealized } from "@/lib/portfolio-math";
import { gridColumns } from "@/lib/shard-math";
import { cn } from "@/lib/utils";

const SHARD = 10n ** 18n;
const lc = (a: string) => a.toLowerCase();

/** "$22,256.00" */
const full = (x: bigint | null) => (x == null ? "n/a" : money(x));
const short = (x: bigint | null) => (x == null ? "n/a" : x % 1_000_000n === 0n || x >= 1_000_000_000n ? money(x, 0) : money(x));
const signed = (x: bigint) => (x >= 0n ? `+${money(x)}` : `-${money(-x)}`);

/** The card under a grid of one cell per shard (bands above 64), my cells outlined in kin. */
function ShardGrid({ image, name, total, mine, fromEnd }: { image: string | null; name: string; total: number; mine: bigint; fromEnd: boolean }) {
  const cols = gridColumns(total);
  const cells = Math.min(total, Number((mine + SHARD - 1n) / SHARD));
  const isMine = (i: number) => (fromEnd ? i >= total - cells : i < cells);
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-full max-w-[236px]">
        {image ? <CardArt src={image} alt={name} className="w-full" /> : <div className="aspect-[63/88] w-full rounded-[4.5%/3.3%] bg-surface-2" />}
        <div aria-hidden className="absolute inset-0 overflow-hidden rounded-[4.5%/3.3%]">
          {cols ? (
            <div className="grid size-full gap-0.5 p-0.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${total / cols}, minmax(0, 1fr))` }}>
              {Array.from({ length: total }, (_, i) => (
                <span key={i} data-cell={isMine(i) ? "mine" : "other"} className={cn("rounded-[3px] border", isMine(i) ? "border-kin bg-kin/10" : "border-white/15 bg-black/35")} />
              ))}
            </div>
          ) : (
            <div className={cn("flex size-full", fromEnd ? "flex-col-reverse" : "flex-col")}>
              <span className="border border-kin bg-kin/10" style={{ flex: `${cells} 0 0%` }} />
              <span className="bg-black/35" style={{ flex: `${total - cells} 0 0%` }} />
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-5 text-[13px] text-text-2">
        <span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-[2px] bg-kin" />Yours · {shardsFixed(mine, mine % SHARD === 0n ? 0 : 1)}</span>
        <span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-[2px] bg-text-2/60" />Others · {shardsFixed(BigInt(total) * SHARD - mine, (BigInt(total) * SHARD - mine) % SHARD === 0n ? 0 : 1)}</span>
      </div>
    </div>
  );
}

const ICONS: Record<HistoryRow["kind"], LucideIcon> = {
  shard: LayersIcon, settle: CheckCheckIcon, bid: GavelIcon, exit: GavelIcon, claim: DownloadIcon, payout: CoinsIcon, redeem: KeyRoundIcon, transfer: SendIcon, verified: BadgeCheckIcon,
};

function History({ rows, now }: { rows: readonly HistoryRow[]; now: number }) {
  if (rows.length === 0) return <p className="text-[13px] text-text-2">Nothing yet on this card.</p>;
  return (
    <ul className="flex flex-col">
      {rows.map((r) => {
        const Icon = r.kind === "exit" && r.title === "Bid refunded" ? Undo2Icon : ICONS[r.kind];
        return (
          <li key={r.key} className="flex items-center gap-3 border-b border-border py-3.5 last:border-0">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-2"><Icon aria-hidden className="size-4" /></span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[14px] text-text">{r.title}</span>
              <span className="truncate text-[12px] text-text-2">{r.detail}</span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              {r.amount != null && <span className={cn("font-mono text-[13px]", r.amount >= 0n ? "text-good-fg" : "text-text")}>{signed(r.amount)}</span>}
              <span className="text-[12px] text-muted-foreground">{ago(r.timestamp, now)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function AboutRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-3.5 last:border-0">
      <span className="text-[13px] text-text-2">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-[13px] text-text">{children}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px] text-text-2">{label}</span>
      <span className="truncate font-mono text-[14px] text-text">{value}</span>
    </div>
  );
}

/** My live balanceOf and the token's totalSupply, for the send sheet; the indexer's values until they load. */
function useLiveBalance(token: Address | null, me: Address | null, fallback: { balance: bigint; supply: bigint }) {
  const io = useVaultIo();
  const q = useQuery({
    queryKey: ["my-shards-chain", token, me?.toLowerCase() ?? null],
    queryFn: async () => {
      const [balance, supply] = await Promise.all([
        io.read<bigint>({ address: token!, abi: abi.shardToken, functionName: "balanceOf", args: [me!] }),
        io.read<bigint>({ address: token!, abi: abi.shardToken, functionName: "totalSupply" }),
      ]);
      return { balance, supply };
    },
    enabled: !!token && !!me,
    refetchInterval: 12_000,
  });
  return q.data ?? fallback;
}

export type MyShardsViewProps = {
  c: CardData;
  me: `0x${string}`;
  now: number;
  /** My bidder binding (World ID), for the history. */
  binding: { boundAt: number; blockNumber: bigint } | null;
  feeBps: number | null;
};

/** My shards (sWbGq for the seller / a holder who can redeem, e2yS2e for a buyer): my position in one card. */
export function MyShardsView({ c, me, now, binding, feeBps }: MyShardsViewProps) {
  const [sending, setSending] = useState(false);
  const card = c.card!;
  const s = c.sharding;
  const identity = identityOf(c);
  const id = card.id.toString();
  const live = useLiveBalance(s?.shardToken ?? null, me, { balance: c.myBalance, supply: c.supply });
  const nav = <MobileNav title="My shards" fallback="/app/portfolio" className="-mt-2" />;

  if (!s || live.balance === 0n) {
    return (
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
        {nav}
        <div className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-surface p-5">
          <h1 className="text-[16px] font-semibold text-text">You don&apos;t hold shards of {identity.name}</h1>
          <p className="text-[13px] text-text-2">Your shards of this card may have been sent, paid out or redeemed.</p>
          <Button asChild variant="secondary" size="compact"><Link href={`/app/cards/${id}`}>Open the card page</Link></Button>
        </div>
      </div>
    );
  }

  const balance = live.balance;
  const supply = live.supply > 0n ? live.supply : BigInt(s.totalShards) * SHARD;
  const seller = isSeller(me, s, c.activities);
  const mine = c.bids.filter((b) => lc(b.owner) === lc(me) && lc(b.auction) === lc(s.auction));
  const avg = costBasis(mine);
  const cost = avg ?? (seller ? q96ToUsdcPerShard(s.floorPriceQ96) : null);
  const running = card.state === "auctioning";
  const price = referencePrice({ ...s, clearingUsdcPerShard: running ? clearingOf(s) : s.clearingUsdcPerShard });
  const value = price != null ? (price * balance) / SHARD : null;
  const gain = price != null && cost != null ? unrealized(price, cost, balance) : null;
  const eligible = canRedeem(balance, supply);
  const share = shareOf(balance, supply);
  const paid = cost != null ? (cost * balance) / SHARD : 0n;
  const vsCost = gain != null && paid > 0n ? Number((gain * 10_000n) / paid) / 100 : null;

  const setName = c.attributes?.setName ?? (c.meta ? metaTrait(c.meta, "Set") : undefined);
  const number = c.meta?.description.match(/#(\d+),/)?.[1];
  const rarity = c.attributes?.rarity ?? (c.meta ? metaTrait(c.meta, "Rarity") : undefined);
  const line = [setName, number ? `#${number}` : null, rarity ? rarity.charAt(0).toUpperCase() + rarity.slice(1) : null, card.condition, languageName(card.language)].filter(Boolean).join(" · ");
  const history = historyRows({ me, cardId: card.id, sharding: s, activities: c.activities, binding, seller });

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
      {nav}
      <div className="flex items-center justify-between max-md:hidden">
        <h2 className="text-[16px] font-semibold text-text-2">My shards</h2>
        <Link href={`/app/cards/${id}`} className="text-[13px] text-text-2 hover:text-text">Open the card page</Link>
      </div>
      <ShardGrid image={identity.image} name={identity.name} total={s.totalShards} mine={balance} fromEnd={!seller} />

      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[36px] leading-tight font-semibold text-text">{identity.name}</h1>
        <EnsName name={card.ensName} avatar={false} tone="kin" copyable={false} maxWidthClassName="max-w-full" />
        {line && <p className="text-[13px] text-text-2">{line}</p>}
        <Credit identity={identity} />
      </header>

      <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[12px] text-text-2">Your position</span>
            <span className="truncate font-mono text-[30px] leading-tight text-text">{full(value)}</span>
          </div>
          {gain != null && (
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span className={cn("font-mono text-[15px]", gain >= 0n ? "text-good-fg" : "text-shu")}>{signed(gain)}</span>
              <span className="text-[12px] text-text-2">{avg != null ? `${vsCost != null ? `${vsCost >= 0 ? "+" : ""}${vsCost.toFixed(1)}% ` : ""}vs cost` : gain >= 0n ? "above your floor" : "below your floor"}</span>
            </div>
          )}
        </div>
        <div className="grid grid-cols-4 gap-3">
          <Stat label="Shards" value={`${shardsFixed(balance, balance % SHARD === 0n ? 0 : 1)} / ${s.totalShards}`} />
          <Stat label="Share" value={`${(share * 100).toFixed(1)}%`} />
          <Stat label={avg != null ? "Avg cost" : seller ? "Your floor" : "Avg cost"} value={short(cost)} />
          <Stat label="Price now" value={short(price)} />
        </div>
        <RedemptionMeter
          value={share}
          label="Redemption"
          status={eligible ? "eligible at 80%" : `${shardsFixed(shardsShort(balance, supply))} shards short`}
          fillClassName={eligible ? "bg-kin" : "bg-s1"}
          className={cn(eligible && "[&>div:first-child>span:last-child]:text-kin")}
        />
        <div className="grid grid-cols-2 gap-2.5">
          {eligible ? (
            <Button asChild variant="redeem" size="md" className="h-12 rounded-xl"><Link href={`/app/cards/${id}/redeem`}><PackageOpenIcon aria-hidden />Redeem</Link></Button>
          ) : (
            <Button asChild variant="secondary" size="md" className="h-12 rounded-xl"><Link href={`/app/cards/${id}`}><GavelIcon aria-hidden />Bid again</Link></Button>
          )}
          <Button variant="secondary" size="md" className="h-12 rounded-xl" onClick={() => setSending(true)}><SendIcon aria-hidden />Send</Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-display text-[22px] font-semibold text-text">Your history</h2>
        <History rows={history} now={now} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-display text-[22px] font-semibold text-text">About these shards</h2>
        <div>
          <AboutRow label="Shard token"><a href={explorerAddress(s.shardToken)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">{shortAddress(s.shardToken)} · ERC-20<ExternalLinkIcon aria-hidden className="size-3" /></a></AboutRow>
          <AboutRow label="Supply">{s.totalShards}.0 · 18 decimals</AboutRow>
          <AboutRow label="Auction"><a href={explorerAddress(s.auction)} target="_blank" rel="noreferrer" className="hover:underline">{shortAddress(s.auction)} · {s.settled ? "settled" : running ? "live" : "awaiting settle"}</a></AboutRow>
          <AboutRow label="Custody">Kura vault, Tokyo</AboutRow>
          <AboutRow label="Vault fee">{feeBps != null ? `${feeBps / 100}% on sales and buyouts` : "…"}</AboutRow>
        </div>
      </section>

      <SendShardsSheet open={sending} onOpenChange={setSending} cardName={identity.name} shardToken={s.shardToken} balance={balance} supply={supply} />
    </div>
  );
}
