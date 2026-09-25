"use client";

import type * as React from "react";
import { ShieldCheckIcon } from "lucide-react";
import { AddressName } from "@/components/address-name";
import { CardArt, EnsName, Pill, type PillTone } from "@/components/kura";
import type { CardRow } from "@/hooks/use-card";
import { setRarity } from "@/lib/card-view";
import { cn } from "@/lib/utils";

const STATE_PILL: Record<CardRow["state"], { tone: PillTone; label: string }> = {
  whole: { tone: "neutral", label: "Whole" },
  auctioning: { tone: "live", label: "Live auction" },
  sharded: { tone: "sharded", label: "Sharded · settled" },
  released: { tone: "released", label: "Released" },
};

export type Identity = {
  name: string;
  image: string | null;
  set?: string;
  rarity?: string;
  artist: string | null;
};

/** Status pill, then neutral "LEA · Rare" and "NM · EN". */
export function CardPills({ card, identity, className }: { card: Pick<CardRow, "state" | "condition" | "language">; identity: Identity; className?: string }) {
  const s = STATE_PILL[card.state];
  const sr = setRarity(identity.set, identity.rarity);
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Pill tone={s.tone} dot={card.state !== "whole"}>{s.label}</Pill>
      {sr && <Pill dot={false}>{sr}</Pill>}
      <Pill dot={false}>{card.condition} · {card.language.toUpperCase()}</Pill>
    </div>
  );
}

/**
 * The right column's head (HisVE): pills, the Fraunces name, the kin ENS name with copy, and a context line. A
 * released card's name shows in muted grey ("name revoked on release").
 */
export function CardHeader({ card, identity, context, className }: {
  card: Pick<CardRow, "state" | "condition" | "language" | "ensName">;
  identity: Identity;
  context?: React.ReactNode;
  className?: string;
}) {
  const released = card.state === "released";
  return (
    <header className={cn("flex flex-col gap-3", className)}>
      <CardPills card={card} identity={identity} />
      <h1 className="font-display text-[40px] leading-[1.05] font-semibold text-text md:text-[56px]">{identity.name}</h1>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-text-2">
        <EnsName name={card.ensName} avatar={false} tone={released ? "text" : "kin"} maxWidthClassName="max-w-[22rem]" className={cn("[&>span:first-child]:text-[15px]", released && "[&>span:first-child]:text-muted-foreground")} />
        {context && <span className="inline-flex min-w-0 items-center gap-1">· {context}</span>}
      </div>
    </header>
  );
}

/** The Holders / Activity tabs' compact header: thumb, name, then `ens · state · N shards` in kin mono. */
export function CompactHeader({ card, identity, shards }: { card: Pick<CardRow, "state" | "ensName">; identity: Identity; shards: number | null }) {
  return (
    <header className="flex items-center gap-5">
      {identity.image ? <CardArt src={identity.image} alt={identity.name} className="w-14 shrink-0 rounded-[4px]" /> : <div className="aspect-[63/88] w-14 rounded-[4px] bg-surface-2" />}
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="truncate font-display text-[28px] font-semibold text-text md:text-[34px]">{identity.name}</h1>
        <p className="truncate font-mono text-[12px] text-kin">
          {[card.ensName, card.state, shards != null ? `${shards} shards` : null].filter(Boolean).join(" · ")}
        </p>
      </div>
    </header>
  );
}

/** The left column's art: the card in a surface frame, the custody line and the credit line. */
export function CardArtColumn({ identity, condition, released, children }: { identity: Identity; condition: string; released: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-3xl border border-border bg-surface p-5 md:p-8">
        {identity.image ? (
          <CardArt src={identity.image} alt={identity.name} className={cn("mx-auto w-full max-w-[230px] md:max-w-[340px]", released && "opacity-70")} />
        ) : (
          <div className="mx-auto aspect-[63/88] w-full max-w-[230px] animate-pulse md:max-w-[340px] rounded-[4.5%/3.3%] bg-surface-2" />
        )}
      </div>
      <p className="flex items-center gap-2 text-[13px] text-text-2">
        <ShieldCheckIcon aria-hidden className="size-4 shrink-0 text-kin" />
        {released ? "Released from the Kura vault" : "Held in the Kura vault"} · Tokyo · Verified {condition}
      </p>
      <p className="text-[11px] text-muted-foreground">
        {identity.artist ? `Illustrated by ${identity.artist} · ` : ""}© Wizards of the Coast · via Scryfall
      </p>
      {children}
    </div>
  );
}

/** "sharded by paolo.kura.eth" */
export function ShardedBy({ address }: { address: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      sharded by <AddressName address={address} avatar={false} copyable={false} className="[&>span]:font-sans [&>span]:text-[14px] [&>span]:text-text-2" />
    </span>
  );
}
