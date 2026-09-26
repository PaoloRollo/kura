// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { MobileNav } from "@/components/mobile-nav";
import { TopBar } from "@/components/kura";
import { canGoBack, recordNavigation, resetNavigation } from "@/lib/nav-history";

afterEach(cleanup);
beforeEach(() => {
  resetNavigation();
  router.back.mockReset();
});

describe("nav history", () => {
  it("can go back only after an in-app navigation", () => {
    recordNavigation("/app/cards/1");
    expect(canGoBack()).toBe(false); // the first page of the visit (a deep link) has nothing to go back to
    recordNavigation("/app/cards/1"); // re-render of the same path, not a navigation
    expect(canGoBack()).toBe(false);
    recordNavigation("/app/cards/2");
    expect(canGoBack()).toBe(true);
  });
});

describe("MobileNav", () => {
  it("goes back through the router when there is in-app history", () => {
    recordNavigation("/app");
    recordNavigation("/app/cards/1");
    render(<MobileNav title="Black Lotus" />);
    fireEvent.click(screen.getByRole("link", { name: "Back" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("links to /app when the card page was opened directly", () => {
    recordNavigation("/app/cards/1");
    render(<MobileNav title="Black Lotus" />);
    const back = screen.getByRole("link", { name: "Back" });
    expect(back.getAttribute("href")).toBe("/app");
    fireEvent.click(back);
    expect(router.back).not.toHaveBeenCalled();
    expect(screen.getByText("Black Lotus")).toBeTruthy();
  });
});

describe("TopBar", () => {
  it("points the logo at the given home", () => {
    render(<TopBar homeHref="/app" />);
    expect(screen.getByRole("link", { name: "Kura home" }).getAttribute("href")).toBe("/app");
  });
});
