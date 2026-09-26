"use client";

import Link from "next/link";
import { PackageCheckIcon } from "lucide-react";
import { AddressName } from "@/components/address-name";
import { CardArt } from "@/components/kura";
import { MobilePageTitle } from "@/components/page-title";
import { IndexerLoading } from "@/components/sync-state";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A card that left the vault: its art and name, the holder it went to and when. */
export type ReleasedCard = { id: bigint; name: string; image: string | null; to: `0x${string}`; releasedAt: number | null };

export type VaultViewProps = {
  /** "kura.eth" */
  parentName: string;
  feeBps: number | null;
  /** Cards not released (whole, auctioning or sharded). */
  cardsHeld: number;
  /** Σ fee events, USDC. */
  feesEarned: bigint;
  released: readonly ReleasedCard[];
  isLoading: boolean;
};

/** "Sep 26" */
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2.5 last:border-0">
      <span className="text-[13px] text-text-2">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-[13px] text-text">{children}</span>
    </div>
  );
}

/** Collector · Vault (Pu0g5): the parent name, the counter's pitch, its stats and the cards that left it. */
export function VaultView({ parentName, feeBps, cardsHeld, feesEarned, released, isLoading }: VaultViewProps) {
  return (
    <section className="flex flex-col gap-8 md:gap-10">
      <MobilePageTitle title="Vault" className="-mt-2 -mb-4" />
      <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-16 lg:pt-4">
        <div className="flex flex-col gap-4">
          <span className="font-mono text-[14px] text-kin">{parentName}</span>
          <h1 className="font-display text-[36px] leading-[1.1] font-semibold text-text md:text-[44px]">One vault, one counter, in Tokyo.</h1>
          <p className="max-w-[640px] text-[15px] text-text-2">
            Every card here was scanned in person, graded by the vendor and sealed in a numbered sleeve. It stays here until one person owns enough of it to take it home.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-surface px-5">
          <Row label="Vendor fee">{feeBps != null ? `${feeBps / 100}% of sales and buyouts` : "…"}</Row>
          <Row label="Cards held">{isLoading ? "…" : cardsHeld}</Row>
          <Row label="Fees earned">{isLoading ? "…" : money(feesEarned)}</Row>
          <Row label="Handovers">{isLoading ? "…" : `${released.length} · Passport verified`}</Row>
          <Row label="Vendor">verified human · World ID</Row>
        </div>
      </div>

      <section className="flex flex-col gap-5">
        <h2 className="font-display text-[24px] font-semibold text-text md:text-[28px]">Released from the vault</h2>
        {isLoading ? (
          <IndexerLoading title="Loading the vault" className="max-w-md" />
        ) : released.length === 0 ? (
          <div className="flex max-w-md flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
            <span className="flex size-11 items-center justify-center rounded-lg bg-surface-2 text-good-fg"><PackageCheckIcon aria-hidden className="size-5" /></span>
            <h3 className="text-[16px] font-semibold text-text">No handovers yet</h3>
            <p className="text-[13px] text-text-2">When a holder redeems a card and picks it up at the counter with a Passport check, it shows here.</p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {released.map((r) => (
              <li key={r.id.toString()}>
                <Link href={`/app/cards/${r.id}`} className="flex items-center gap-4 rounded-2xl border border-border bg-surface px-4 py-3.5 transition-colors hover:border-text-2/40">
                  {r.image ? <CardArt src={r.image} alt={r.name} className="w-10 shrink-0 rounded-[3px] shadow-none" /> : <div className="aspect-[63/88] w-10 shrink-0 rounded-[3px] bg-surface-2" />}
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-[14px] font-semibold text-text">{r.name}</span>
                    <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[12px] text-text-2">
                      to <AddressName address={r.to} avatar={false} copyable={false} maxWidthClassName="max-w-[10rem]" className="[&>span]:text-[12px] [&>span]:text-text-2" />
                    </span>
                    <span className={cn("text-[12px] text-muted-foreground")}>{r.releasedAt != null ? `${day(r.releasedAt)} · ` : ""}name revoked</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
