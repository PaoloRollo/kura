// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { HeroCards, fanProgress } from "@/components/hero-cards";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener: () => {}, removeEventListener: () => {} }),
  });
}

function scrollTo(y: number) {
  Object.defineProperty(window, "scrollY", { configurable: true, value: y });
  window.dispatchEvent(new Event("scroll"));
}

describe("fanProgress", () => {
  it("is 0 at the top, 1 once the fan distance is scrolled, and linear in between", () => {
    expect(fanProgress(0, 400)).toBe(0);
    expect(fanProgress(200, 400)).toBe(0.5);
    expect(fanProgress(400, 400)).toBe(1);
    expect(fanProgress(5000, 400)).toBe(1);
    expect(fanProgress(-50, 400)).toBe(0); // iOS overscroll
  });
});

describe("HeroCards", () => {
  it("renders the three cards: Time Walk, Black Lotus and Mox Sapphire", () => {
    setReducedMotion(false);
    const { container } = render(<HeroCards />);
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "");
    for (const c of ["time-walk", "black-lotus", "mox-sapphire"]) expect(srcs.some((s) => s.includes(c))).toBe(true);
  });

  it("fans out as the page scrolls down and back in as it scrolls up", () => {
    setReducedMotion(false);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
    const { container } = render(<HeroCards />);
    const root = container.firstElementChild as HTMLElement;
    const fan = () => Number(root.style.getPropertyValue("--fan"));
    act(() => scrollTo(0));
    expect(fan()).toBe(0);
    act(() => scrollTo(10_000));
    expect(fan()).toBe(1);
    const out = fan();
    act(() => scrollTo(0));
    expect(fan()).toBeLessThan(out);
    expect(fan()).toBe(0);
  });

  it("stays still for people who prefer reduced motion", () => {
    setReducedMotion(true);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
    const { container } = render(<HeroCards />);
    const root = container.firstElementChild as HTMLElement;
    act(() => scrollTo(10_000));
    expect(Number(root.style.getPropertyValue("--fan") || 0)).toBe(0);
    expect(root.dataset.motion).toBe("reduced");
  });
});
