"use client";

import type * as React from "react";
import { useState } from "react";
import Link from "next/link";
import { AtSignIcon, BadgeCheckIcon, CheckIcon, CopyIcon, ExternalLinkIcon, KeyRoundIcon, LogOutIcon } from "lucide-react";
import { AddressName } from "@/components/address-name";
import { Button } from "@/components/kura";
import { shortAddress, usdc } from "@/lib/format";
import { cn } from "@/lib/utils";

export const FAUCET_URL = "https://faucet.circle.com";

export type ProfileViewProps = {
  me: `0x${string}`;
  /** "paolo.kura.eth", or null without a handle. */
  handle: string | null;
  usdc: bigint | null;
  verified: boolean;
  /** "Embedded · Privy", or the external wallet's name. */
  wallet: string;
  embedded: boolean;
  onLogout: () => void;
};

function Row({ icon: Icon, label, children, tone }: { icon: typeof AtSignIcon; label: string; children: React.ReactNode; tone?: "good" | "kin" }) {
  return (
    <div className="flex items-center gap-3.5 border-b border-border py-4">
      <Icon aria-hidden className={cn("size-5 shrink-0", tone === "good" ? "text-good-fg" : tone === "kin" ? "text-kin" : "text-text-2")} />
      <span className="flex-1 text-[15px] text-text">{label}</span>
      <span className="min-w-0 truncate text-right text-[13px]">{children}</span>
    </div>
  );
}

/** Mobile · Profile (xog3h): who I am, my USDC with the faucet, World ID, handle, wallet, address and log out. */
export function ProfileView({ me, handle, usdc: balance, verified, wallet, embedded, onLogout }: ProfileViewProps) {
  const [copied, setCopied] = useState(false);
  const empty = balance === 0n;
  async function copy() {
    try {
      await navigator.clipboard.writeText(me);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the address stays visible.
    }
  }
  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-6 pt-4">
      <div className="flex flex-col items-center gap-3">
        <span aria-hidden className="size-[84px] rounded-full bg-[linear-gradient(-135deg,var(--kura-s7)_15%,var(--kura-shu)_85%)]" />
        <AddressName address={me} avatar={false} copyable={false} maxWidthClassName="max-w-[18rem]" className="[&>span]:text-[18px]" />
        <span className="font-mono text-[12px] text-muted-foreground">{shortAddress(me)}</span>
      </div>

      <section className={cn("flex flex-col gap-3 rounded-2xl border bg-surface p-4", empty ? "border-shu/50" : "border-border")}>
        <span className="text-[12px] text-text-2">USDC on Sepolia</span>
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[30px] leading-none text-text">{balance != null ? usdc(balance) : "…"}</span>
          <Button asChild variant={empty ? "primary" : "secondary"} size="compact">
            <a href={FAUCET_URL} target="_blank" rel="noreferrer">Get test USDC<ExternalLinkIcon aria-hidden /></a>
          </Button>
        </div>
        <p className="text-[12px] text-text-2">
          {empty ? "You need USDC to bid. " : ""}From faucet.circle.com. {embedded ? "Gas is always covered by Kura." : "Your wallet pays its own gas."}
        </p>
      </section>

      <div className="flex flex-col">
        <Row icon={BadgeCheckIcon} label="World ID" tone={verified ? "good" : undefined}>
          {verified ? <span className="text-good-fg">Verified · bids unlocked</span> : <span className="text-text-2">Verify on your first bid</span>}
        </Row>
        <Row icon={AtSignIcon} label="Handle" tone="kin">
          {handle ? <span className="font-mono text-kin">{handle}</span> : <Link href="/app/onboarding" className="font-semibold text-kin hover:underline">Claim</Link>}
        </Row>
        <Row icon={KeyRoundIcon} label="Wallet"><span className="text-text-2">{wallet}</span></Row>
        <button type="button" onClick={copy} className="text-left" aria-label="Copy address">
          <Row icon={copied ? CheckIcon : CopyIcon} label="Address"><span className="font-mono text-text-2">{copied ? "copied" : shortAddress(me)}</span></Row>
        </button>
        <button type="button" onClick={onLogout} className="flex items-center gap-3.5 py-4 text-left text-[15px] text-shu">
          <LogOutIcon aria-hidden className="size-5" />Log out
        </button>
      </div>
    </div>
  );
}
