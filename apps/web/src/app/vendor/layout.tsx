"use client";

import Link from "next/link";
import { ArrowLeftRightIcon, LogInIcon, ShieldXIcon, StoreIcon } from "lucide-react";
import deployments from "@/generated/deployments.json";
import { GateCard } from "@/components/gate-card";
import { SiteHeader, shortAddress } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { useKuraUser } from "@/hooks/use-kura-user";

export default function VendorLayout({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout, isVendor, address } = useKuraUser();
  return (
    <div className="min-h-screen">
      <SiteHeader role="vendor" />
      <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">
        {!ready ? null : !authenticated ? (
          <GateCard icon={<StoreIcon />} title="Open the counter">
            <p className="max-w-[24rem] text-[14px] leading-relaxed text-text-2">
              Sign in with the vendor wallet to scan cards, mint digital twins and confirm handovers at the counter.
            </p>
            <Button variant="primary" size="md" className="mt-1 w-full" onClick={login}>
              <LogInIcon />Sign in as vendor
            </Button>
            <Link href="/app" className="text-[12px] text-muted-foreground hover:text-text-2">
              Collectors, head to the app instead
            </Link>
          </GateCard>
        ) : !isVendor ? (
          <GateCard icon={<ShieldXIcon />} title="This wallet isn't the vault vendor" tone="warn">
            <p className="max-w-[24rem] text-[14px] leading-relaxed text-text-2">
              {address ? shortAddress(address) : "This wallet"} is signed in, but only the whitelisted vendor wallet can mint twins and hand cards over.
            </p>
            <div className="flex w-full items-center justify-between gap-3 rounded-md bg-bg px-3 py-3 text-[12px]">
              <span className="text-muted-foreground">Vendor wallet</span>
              <span className="truncate font-mono text-kin">
                {deployments.ensParentLabel}.eth · {shortAddress(deployments.vendor)}
              </span>
            </div>
            <Button
              variant="secondary"
              size="md"
              className="w-full border-transparent bg-surface-2 hover:bg-surface-2/80"
              onClick={async () => {
                await logout();
                login();
              }}
            >
              <ArrowLeftRightIcon />Switch wallet
            </Button>
            <Link href="/app" className="text-[12px] text-muted-foreground hover:text-text-2">
              Looking for your cards? Open the collector app
            </Link>
          </GateCard>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
