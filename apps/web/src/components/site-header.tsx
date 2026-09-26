"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  ArrowRightLeftIcon,
  ChartColumnIcon,
  CircleDollarSignIcon,
  CompassIcon,
  CopyIcon,
  LandmarkIcon,
  LogOutIcon,
  PackageIcon,
  ScanLineIcon,
  UserIcon,
  WalletIcon,
} from "lucide-react";
import { BarChip, TabBar, TopBar, type NavItem } from "@/components/kura";
import { NotificationsBell } from "@/components/notifications-panel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { useDisplayName } from "@/hooks/use-handles";
import { useKuraUser } from "@/hooks/use-kura-user";
import { addresses, publicClient } from "@/lib/chain";
import { usePayoutBalance } from "@/hooks/use-vendor-data";
import { usdc } from "@/lib/format";
import { recordNavigation } from "@/lib/nav-history";

export const NAV: Record<"vendor" | "collector", NavItem[]> = {
  vendor: [
    { href: "/vendor/scan", label: "Scan", icon: ScanLineIcon },
    { href: "/vendor/vault", label: "Inventory", icon: PackageIcon },
    // Handover is the inventory on its Whole tab, where the cards awaiting a handover are.
    { href: "/vendor/vault?tab=whole", label: "Handover", icon: ArrowRightLeftIcon },
    { href: "/vendor/fees", label: "Fees", icon: LandmarkIcon },
  ],
  collector: [
    { href: "/app", label: "Explore", icon: CompassIcon },
    { href: "/app/portfolio", label: "Portfolio", icon: WalletIcon },
    { href: "/app/analytics", label: "Analytics", icon: ChartColumnIcon },
    { href: "/app/vault", label: "Vault", icon: LandmarkIcon },
  ],
};

// The 390 tab bar swaps the collector's Vault for Profile (Z6BlV0); the vendor tabs match the top bar.
const TABS: Record<"vendor" | "collector", NavItem[]> = {
  vendor: NAV.vendor,
  collector: [...NAV.collector.slice(0, 3), { href: "/app/profile", label: "Profile", icon: UserIcon }],
};

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The wallet/ENS chip: gradient avatar, the Kura name (or short address), role; opens a menu to copy the address or log out. */
function WalletChip({ address, role, onLogout }: { address: string; role?: string; onLogout: () => void }) {
  const name = useDisplayName(address);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-9 max-w-[16rem] items-center gap-2 rounded-md border border-border bg-bg px-3 font-mono text-[13px] text-text outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span aria-hidden className="size-[18px] shrink-0 rounded-full bg-[linear-gradient(-135deg,var(--kura-s7)_15%,var(--kura-shu)_85%)]" />
          <span className="truncate">{name}</span>
          {role && <span className="hidden text-text-2 sm:inline">· {role}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate font-mono text-[12px] text-muted-foreground">{address}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(address).catch(() => {})}>
          <CopyIcon />Copy address
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onLogout}>
          <LogOutIcon />Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The vendor's "Fees 412.30 USDC" chip: USDC held by the vault's payout address. */
function FeesChip() {
  const balance = usePayoutBalance();
  return <BarChip icon={CircleDollarSignIcon} className="hidden lg:inline-flex">Fees {balance != null ? usdc(balance) : "…"} USDC</BarChip>;
}

/** The collector's "248.50 USDC" chip. Keyed ["usdc", address] so a confirmed transaction refreshes it. */
function UsdcChip({ address }: { address: string }) {
  const { data } = useQuery({
    queryKey: ["usdc", address.toLowerCase()],
    queryFn: () => publicClient.readContract({ abi: erc20Abi, address: addresses.usdc, functionName: "balanceOf", args: [address as Address] }),
    refetchInterval: 30_000,
  });
  return <BarChip icon={CircleDollarSignIcon} className="hidden sm:inline-flex">{data != null ? usdc(data) : "…"} USDC</BarChip>;
}

/** The path the nav matches against. Handover is /vendor/vault?tab=whole, so the vault's tab counts as part of it. */
function useNavPath() {
  const pathname = usePathname() ?? "";
  const tab = useSearchParams()?.get("tab");
  return pathname === "/vendor/vault" && tab === "whole" ? `${pathname}?tab=whole` : pathname;
}

/** App shell top bar (and mobile tab bar) for the collector app and the vendor station. */
export function SiteHeader({ role }: { role: "vendor" | "collector" }) {
  // useSearchParams needs a Suspense boundary so static pages can still prerender; the fallback ignores the query.
  return (
    <Suspense fallback={<Header role={role} path={null} />}>
      <HeaderWithPath role={role} />
    </Suspense>
  );
}

function HeaderWithPath({ role }: { role: "vendor" | "collector" }) {
  return <Header role={role} path={useNavPath()} />;
}

function Header({ role, path }: { role: "vendor" | "collector"; path: string | null }) {
  const { ready, authenticated, login, logout, address, isVendor } = useKuraUser();
  const bare = usePathname() ?? "";
  const pathname = path ?? bare;
  const signedIn = ready && authenticated;
  // The signed-out and not-authorised vendor screens show only the wordmark and the station badge.
  const showNav = role === "collector" ? signedIn : signedIn && isVendor;
  const nav = showNav ? NAV[role] : [];
  // Claim handle (D0ZWe) is a full-screen step on mobile: no top bar, wallet chip or tab bar.
  const fullScreenStep = bare === "/app/onboarding";
  // A card page (yV8eD) is a detail screen: its own CTAs pin to the bottom on mobile instead of the tab bar.
  // On mobile it shows its own Nav row (MobileNav: back, title, share) in place of the top bar.
  // My shards (sWbGq) is a detail screen too.
  const detail = bare.startsWith("/app/cards/") || bare.startsWith("/app/portfolio/");
  // The collector's tab screens (Z6BlV0, YH4Ft, xog3h) open on their own "蔵 Title" row instead of the top bar.
  const tabRoot = role === "collector" && signedIn && ["/app", "/app/portfolio", "/app/vault", "/app/profile"].includes(bare);
  const tabs = showNav && !fullScreenStep && !detail ? TABS[role] : [];
  useEffect(() => recordNavigation(bare), [bare]);
  return (
    <>
      <TopBar
        className={fullScreenStep || detail || tabRoot ? "max-md:hidden" : undefined}
        homeHref={role === "collector" ? "/app" : "/vendor"}
        nav={nav}
        pathname={pathname}
        exactHrefs={["/app"]}
        badge={role === "vendor" ? "Vendor station" : undefined}
        right={
          signedIn && address ? (
            <>
              {role === "vendor" && isVendor && <FeesChip />}
              {/* RWhQ9: the bell sits before the USDC chip; desktop only (no mobile screen has it). */}
              {role === "collector" && <NotificationsBell address={address} className="max-md:hidden" />}
              {role === "collector" && <UsdcChip address={address} />}
              <WalletChip address={address} role={isVendor ? "vendor" : undefined} onLogout={logout} />
            </>
          ) : role === "collector" ? (
            <Button variant="inverse" size="compact" onClick={login} disabled={!ready}>
              Log in
            </Button>
          ) : null
        }
      />
      {tabs.length > 0 && <TabBar nav={tabs} pathname={pathname} exactHrefs={["/app"]} />}
    </>
  );
}
