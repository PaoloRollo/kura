"use client";

import { GlobeIcon, MailIcon, WalletIcon } from "lucide-react";
import { CardFan } from "@/components/card-fan";
import { Button } from "@/components/kura";

export type LoginMethod = "email" | "google" | "wallet";

/** Mobile · Login (OoX90), centred on desktop: the card fan, the wordmark and one button per login method. */
export function CollectorLogin({ onLogin, disabled }: { onLogin: (method: LoginMethod) => void; disabled?: boolean }) {
  return (
    <section className="mx-auto flex min-h-[calc(100dvh-10rem)] max-w-[22rem] flex-col items-center justify-center gap-8 text-center">
      <CardFan size="sm" className="h-52 w-full" />
      <div className="flex flex-col items-center gap-3">
        <p className="font-display text-[34px] font-semibold text-text">
          <span lang="ja" className="text-shu">蔵</span> Kura
        </p>
        <p className="text-[15px] text-text-2">Own shards of real cards, held in a real vault.</p>
      </div>
      <div className="flex w-full flex-col gap-2.5">
        <Button variant="inverse" size="md" className="w-full" disabled={disabled} onClick={() => onLogin("email")}><MailIcon />Continue with email</Button>
        <Button variant="secondary" size="md" className="w-full" disabled={disabled} onClick={() => onLogin("google")}><GlobeIcon />Continue with Google</Button>
        <Button variant="secondary" size="md" className="w-full" disabled={disabled} onClick={() => onLogin("wallet")}><WalletIcon />Connect a wallet</Button>
        <p className="pt-1 text-[12px] text-muted-foreground">A wallet is created for you. No seed phrase, no gas fees.</p>
      </div>
    </section>
  );
}
