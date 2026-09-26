// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-notifications", () => ({ useNotifications: vi.fn() }));

import { NotificationsMenu } from "@/components/notifications-panel";
import type { Notification } from "@/lib/notifications";

const row: Notification = { id: "r1", kind: "outbid", cardId: 1n, title: "You were outbid on Black Lotus", body: "Clearing $1,772 passed your $1,760 max", time: 100, href: "/app/cards/1?tab=auction", action: "Raise bid" };

function open(unread: string[], markAllRead = vi.fn(), onSelect = vi.fn()) {
  render(<NotificationsMenu defaultOpen data={{ rows: [row], unread: new Set(unread), now: 220, markAllRead }} onSelect={onSelect} />);
  return { markAllRead, onSelect };
}

describe("NotificationsMenu", () => {
  it("Mark all read is a keyboard-reachable menu item that keeps the menu open", () => {
    const { markAllRead } = open(["r1"]);
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toContain("Mark all read");
    const mark = screen.getByRole("menuitem", { name: "Mark all read" });
    // Arrow navigation lands on it: it is one of the menu's items, not a plain button.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(mark);
    fireEvent.click(mark);
    expect(markAllRead).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("is disabled with nothing unread; rows are direct menu items that select", () => {
    const { markAllRead, onSelect } = open([]);
    const mark = screen.getByRole("menuitem", { name: "Mark all read" });
    expect(mark.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(mark);
    expect(markAllRead).not.toHaveBeenCalled();
    const item = screen.getAllByRole("menuitem").find((i) => i.textContent?.includes("outbid"))!;
    expect(item.closest("ul, li")).toBeNull();
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith(row);
  });
});
