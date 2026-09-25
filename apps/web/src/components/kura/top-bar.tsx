import type * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";

export type NavItem = {
  href: string;
  label: string;
  icon?: LucideIcon;
  /** Not built yet: shown, but not a link. */
  soon?: boolean;
};

function isActive(pathname: string, href: string, exact: boolean) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export type TopBarProps = {
  nav?: NavItem[];
  pathname?: string;
  /** Match nav items exactly (for a root item like /app that would otherwise match everything). */
  exactHrefs?: string[];
  /** Label next to the wordmark ("Vendor station"). */
  badge?: React.ReactNode;
  right?: React.ReactNode;
  /** Draw the hairline under the bar (the app shells); the landing has none. */
  bordered?: boolean;
  className?: string;
};

/** The 1440 "Top bar": wordmark, centred nav, wallet chips on the right. */
export function TopBar({ nav = [], pathname = "", exactHrefs = [], badge, right, bordered = true, className }: TopBarProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-40 bg-bg/90 backdrop-blur supports-[backdrop-filter]:bg-bg/75",
        bordered && "border-b border-border",
        className,
      )}
    >
      <div className="mx-auto grid h-16 max-w-[1440px] grid-cols-[1fr_auto] items-center gap-4 px-4 sm:px-6 md:h-[74px] md:grid-cols-[1fr_auto_1fr] lg:px-12">
        <div className="flex min-w-0 items-center gap-3">
          <Logo />
          {badge && <span className="hidden rounded-[6px] bg-surface-2 px-2 py-1 text-[12px] text-text-2 sm:inline">{badge}</span>}
        </div>
        {nav.length > 0 && (
          <nav aria-label="Main" className="hidden items-center gap-8 md:flex">
            {nav.map((item) => {
              const active = isActive(pathname, item.href, exactHrefs.includes(item.href));
              return item.soon ? (
                <span key={item.href} aria-disabled title="Coming soon" className="cursor-default text-[14px] text-text-2">
                  {item.label}
                </span>
              ) : (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn("text-[14px] transition-colors hover:text-text", active ? "font-semibold text-text" : "text-text-2")}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}
        <div className="flex min-w-0 items-center justify-end gap-2 md:col-start-3">{right}</div>
      </div>
    </header>
  );
}

/** Mobile tab bar (390 screens): icon + label, fixed to the bottom, hidden from md up. */
export function TabBar({ nav, pathname = "", exactHrefs = [] }: { nav: NavItem[]; pathname?: string; exactHrefs?: string[] }) {
  return (
    <nav
      aria-label="Tabs"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }}>
        {nav.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href, exactHrefs.includes(item.href));
          const inner = (
            <>
              {Icon && <Icon aria-hidden className={cn("size-[22px]", active && "text-shu")} strokeWidth={1.75} />}
              <span>{item.label}</span>
            </>
          );
          const cls = cn("flex h-[62px] flex-col items-center justify-center gap-1 text-[11px]", active ? "text-text" : "text-muted-foreground");
          return (
            <li key={item.href}>
              {item.soon ? (
                <span aria-disabled className={cn(cls, "opacity-50")}>{inner}</span>
              ) : (
                <Link href={item.href} aria-current={active ? "page" : undefined} className={cls}>
                  {inner}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Chip in the top bar: surface pill with a leading icon and mono text (balance, fees). */
export function BarChip({ icon: Icon, children, className }: { icon?: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-9 items-center gap-2 rounded-md bg-surface px-3 font-mono text-[13px] text-text", className)}>
      {Icon && <Icon aria-hidden className="size-4 text-text-2" />}
      {children}
    </span>
  );
}
