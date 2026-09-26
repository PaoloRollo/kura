"use client";

import { MailIcon, WalletIcon } from "lucide-react";
import { CardFan } from "@/components/card-fan";
import { Button } from "@/components/kura";

export type LoginMethod = "email" | "wallet";

/**
 * Mobile · Login (OoX90), full screen with no top bar: the card fan and wordmark centred, one button per login method
 * pinned to the bottom. On desktop the same column is centred.
 */
export function CollectorLogin({ onLogin }: { onLogin: (method: LoginMethod) => void }) {
  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col px-6 pt-[max(3rem,env(safe-area-inset-top))] pb-[calc(2.5rem+env(safe-area-inset-bottom,0px))] text-center md:justify-center md:gap-14">
      <div className="flex flex-1 flex-col items-center justify-center gap-8 md:flex-none">
        <CardFan size="md" className="h-[240px] w-full" />
        <div className="flex flex-col items-center gap-3">
          <p className="font-display text-[34px] font-semibold text-text">
            <span lang="ja" className="text-shu">蔵</span> Kura
          </p>
          <p className="text-[15px] text-text-2">Own shards of real cards, held in a real vault.</p>
        </div>
      </div>
      <div className="flex w-full flex-col gap-2.5">
        <Button variant="inverse" size="md" className="w-full" onClick={() => onLogin("email")}><MailIcon />Continue with email</Button>
        <Button variant="secondary" size="md" className="w-full" onClick={() => onLogin("wallet")}><WalletIcon />Connect a wallet</Button>
        <p className="pt-1 text-[12px] text-muted-foreground">With email a wallet is created for you. No seed phrase, no gas fees.</p>
        <p className="text-[12px] text-muted-foreground">A connected wallet pays its own gas in Sepolia ETH.</p>
      </div>
    </section>
  );
}
