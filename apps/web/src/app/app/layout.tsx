"use client";

import { usePathname } from "next/navigation";
import { useLogin } from "@privy-io/react-auth";
import { CollectorLogin } from "@/components/collector-login";
import { HandleBanner } from "@/components/handle-banner";
import { SiteHeader } from "@/components/site-header";
import { useHandlesState } from "@/hooks/use-handles";
import { useKuraUser } from "@/hooks/use-kura-user";
import { useLiveEvents } from "@/hooks/use-live-events";

export default function CollectorLayout({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, address } = useKuraUser();
  const { login } = useLogin();
  const { handles, ready: handlesReady } = useHandlesState();
  const pathname = usePathname() ?? "";
  useLiveEvents();
  if (!ready) return <div className="min-h-screen" />;
  // Login (OoX90) is full-bleed: no top bar.
  if (!authenticated) return <CollectorLogin onLogin={(method) => login({ loginMethods: [method] })} />;
  const onboarding = pathname === "/app/onboarding";
  const unnamed = !!address && handlesReady && !handles[address.toLowerCase()];
  return (
    <div className="min-h-screen">
      <SiteHeader role="collector" />
      <main className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 md:pb-10 lg:px-12 lg:pt-8">
        {unnamed && !onboarding && <HandleBanner />}
        {children}
      </main>
    </div>
  );
}
