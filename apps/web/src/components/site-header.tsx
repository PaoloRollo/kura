"use client";

import { usePathname } from "next/navigation";
import {
  ArrowRightLeftIcon,
  ChartColumnIcon,
  CompassIcon,
  CopyIcon,
  LandmarkIcon,
  LogOutIcon,
  PackageIcon,
  ScanLineIcon,
  UserIcon,
  WalletIcon,
} from "lucide-react";
import { TabBar, TopBar, type NavItem } from "@/components/kura";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useKuraUser } from "@/hooks/use-kura-user";

export const NAV: Record<"vendor" | "collector", NavItem[]> = {
  vendor: [
    { href: "/vendor/scan", label: "Scan", icon: ScanLineIcon },
    { href: "/vendor/inventory", label: "Inventory", icon: PackageIcon, soon: true },
    { href: "/vendor/handover", label: "Handover", icon: ArrowRightLeftIcon, soon: true },
    { href: "/vendor/fees", label: "Fees", icon: LandmarkIcon, soon: true },
  ],
  collector: [
    { href: "/app", label: "Explore", icon: CompassIcon },
    { href: "/app/portfolio", label: "Portfolio", icon: WalletIcon, soon: true },
    { href: "/app/analytics", label: "Analytics", icon: ChartColumnIcon, soon: true },
    { href: "/app/vault", label: "Vault", icon: LandmarkIcon, soon: true },
  ],
};

// The 390 tab bar swaps the collector's Vault for Profile (Z6BlV0); the vendor tabs match the top bar.
const TABS: Record<"vendor" | "collector", NavItem[]> = {
  vendor: NAV.vendor,
  collector: [...NAV.collector.slice(0, 3), { href: "/app/profile", label: "Profile", icon: UserIcon, soon: true }],
};

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The wallet/ENS chip: gradient avatar, mono name, role; opens a menu to copy the address or log out. */
function WalletChip({ address, role, onLogout }: { address: string; role?: string; onLogout: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-9 max-w-[16rem] items-center gap-2 rounded-md border border-border bg-bg px-3 font-mono text-[13px] text-text outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span aria-hidden className="size-[18px] shrink-0 rounded-full bg-[linear-gradient(-135deg,var(--kura-s7)_15%,var(--kura-shu)_85%)]" />
          <span className="truncate">{shortAddress(address)}</span>
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

/** App shell top bar (and mobile tab bar) for the collector app and the vendor station. */
export function SiteHeader({ role }: { role: "vendor" | "collector" }) {
  const { ready, authenticated, login, logout, address, isVendor } = useKuraUser();
  const pathname = usePathname() ?? "";
  const signedIn = ready && authenticated;
  // The signed-out and not-authorised vendor screens show only the wordmark and the station badge.
  const showNav = role === "collector" ? signedIn : signedIn && isVendor;
  const nav = showNav ? NAV[role] : [];
  const tabs = showNav ? TABS[role] : [];
  return (
    <>
      <TopBar
        nav={nav}
        pathname={pathname}
        exactHrefs={["/app"]}
        badge={role === "vendor" ? "Vendor station" : undefined}
        right={
          signedIn && address ? (
            <WalletChip address={address} role={isVendor ? "vendor" : undefined} onLogout={logout} />
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
