// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CardTabs } from "@/components/card-page-view";

afterEach(cleanup);

describe("CardTabs", () => {
  // overflow-x-auto alone makes overflow-y auto too, and the tabs' -mb-px underline then scrolls the row vertically.
  it("scrolls sideways on narrow screens but never vertically", () => {
    render(<CardTabs tab="overview" href={(t) => `?tab=${t}`} />);
    const nav = screen.getByRole("navigation", { name: "Card sections" });
    expect(nav.className).toContain("overflow-x-auto");
    expect(nav.className).toContain("overflow-y-hidden");
  });
});
