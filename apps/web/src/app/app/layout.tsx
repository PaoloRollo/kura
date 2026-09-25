"use client";

import { GlobeIcon, MailIcon, WalletIcon } from "lucide-react";
import { CardFan } from "@/components/card-fan";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { useKuraUser } from "@/hooks/use-kura-user";

export default function CollectorLayout({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login } = useKuraUser();
  return (
    <div className="min-h-screen">
      <SiteHeader role="collector" />
      <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">
        {!ready ? null : !authenticated ? (
          // Login (OoX90). Every method opens the Privy modal, which offers email, Google and wallets.
          <section className="mx-auto flex min-h-[calc(100dvh-10rem)] max-w-[22rem] flex-col items-center justify-center gap-8 text-center">
            <CardFan size="sm" className="h-52 w-full" />
            <div className="flex flex-col items-center gap-3">
              <p className="font-display text-[34px] font-semibold text-text">
                <span lang="ja" className="text-shu">蔵</span> Kura
              </p>
              <p className="text-[15px] text-text-2">Own shards of real cards, held in a real vault.</p>
            </div>
            <div className="flex w-full flex-col gap-2.5">
              <Button variant="inverse" size="md" className="w-full" onClick={login}><MailIcon />Continue with email</Button>
              <Button variant="secondary" size="md" className="w-full" onClick={login}><GlobeIcon />Continue with Google</Button>
              <Button variant="secondary" size="md" className="w-full" onClick={login}><WalletIcon />Connect a wallet</Button>
              <p className="pt-1 text-[12px] text-muted-foreground">A wallet is created for you. No seed phrase, no gas fees.</p>
            </div>
          </section>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
