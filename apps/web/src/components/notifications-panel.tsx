"use client";

import { useRouter } from "next/navigation";
import { BellIcon, CheckCheckIcon, GavelIcon, HandCoinsIcon, KeyRoundIcon, SendIcon, TimerIcon, type LucideIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useNotifications, type NotificationsData } from "@/hooks/use-notifications";
import { ago } from "@/lib/card-view";
import type { Notification, NotificationKind } from "@/lib/notifications";
import { cn } from "@/lib/utils";

const KINDS: Record<NotificationKind, { icon: LucideIcon; tone: string }> = {
  outbid: { icon: GavelIcon, tone: "text-shu" },
  payout: { icon: HandCoinsIcon, tone: "text-kin" },
  "ends-soon": { icon: TimerIcon, tone: "text-s1" },
  settled: { icon: CheckCheckIcon, tone: "text-good-fg" },
  received: { icon: SendIcon, tone: "text-text-2" },
  "can-redeem": { icon: KeyRoundIcon, tone: "text-kin" },
};

function Row({ n, unread, now }: { n: Notification; unread: boolean; now: number }) {
  const { icon: Icon, tone } = KINDS[n.kind];
  return (
    <>
      <span className="flex size-[34px] shrink-0 items-center justify-center rounded-md bg-surface-2">
        <Icon aria-hidden className={cn("size-4", tone)} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-[13px] text-text", unread && "font-semibold")}>{n.title}</span>
        <span className="text-[12px] text-text-2">{n.body}</span>
        {n.action && (
          <span className="mt-1.5 inline-flex h-6 w-fit items-center rounded-md border border-border bg-bg px-2 text-[12px] font-semibold text-text">{n.action}</span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-2 pt-0.5">
        <span className="text-[11px] text-muted-foreground">{ago(n.time, now)}</span>
        {unread && <span aria-label="Unread" className="size-1.5 rounded-full bg-shu" />}
      </span>
    </>
  );
}

/** The bell and its Notifications popover (RWhQ9), from the data it is given. `defaultOpen` is for the preview. */
export function NotificationsMenu({ data, onSelect, defaultOpen, className }: {
  data: Pick<NotificationsData, "rows" | "unread" | "markAllRead" | "now">;
  onSelect: (n: Notification) => void;
  defaultOpen?: boolean;
  className?: string;
}) {
  const { rows, unread, markAllRead, now } = data;
  const hasUnread = unread.size > 0;
  return (
    <DropdownMenu defaultOpen={defaultOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={hasUnread ? `Notifications, ${unread.size} unread` : "Notifications"}
          className={cn(
            "relative inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-surface text-text outline-none hover:bg-surface-2 focus-visible:ring-3 focus-visible:ring-ring/50",
            className,
          )}
        >
          <BellIcon aria-hidden className="size-4" />
          {hasUnread && <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-shu ring-2 ring-surface" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-[420px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface p-0 ring-0 shadow-toast">
        <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
          <h2 className="text-[15px] font-semibold text-text">Notifications</h2>
          <button
            type="button"
            onClick={markAllRead}
            disabled={!hasUnread}
            className="text-[12px] text-text-2 hover:text-text disabled:cursor-default disabled:opacity-60 disabled:hover:text-text-2"
          >
            Mark all read
          </button>
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-text-2">You&apos;re all caught up.</p>
        ) : (
          <ul className="max-h-[min(70vh,560px)] overflow-y-auto">
            {rows.map((n) => (
              <li key={n.id} className="border-b border-border last:border-b-0">
                <DropdownMenuItem
                  onSelect={() => onSelect(n)}
                  className={cn("cursor-pointer items-start gap-3 rounded-none px-4 py-3.5 focus:bg-surface-2", unread.has(n.id) && "bg-shu/5")}
                >
                  <Row n={n} unread={unread.has(n.id)} now={now} />
                </DropdownMenuItem>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The collector top bar's bell (desktop): live notifications for `address`; a row opens its card. */
export function NotificationsBell({ address, className }: { address: string; className?: string }) {
  const data = useNotifications(address);
  const router = useRouter();
  return <NotificationsMenu data={data} onSelect={(n) => router.push(n.href)} className={className} />;
}
