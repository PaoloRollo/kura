"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { GavelIcon } from "lucide-react";
import { CardArt } from "@/components/kura";

/** Pixels of scroll over which the hero cards go from their resting fan to fully spread. */
const FAN_DISTANCE = 420;

/** Scroll position to fan amount: 0 at the top, 1 once `distance` is scrolled, clamped (iOS overscroll is negative). */
export function fanProgress(scrollY: number, distance: number): number {
  return Math.min(1, Math.max(0, scrollY / distance));
}

/**
 * Each card's extra spread at full fan, on top of its resting position. Driven by the `--fan` custom property (0..1),
 * so scrolling back up reverses it exactly.
 */
const spread = {
  left: "translate(calc(var(--fan) * -34%), calc(var(--fan) * 6%)) rotate(calc(var(--fan) * -9deg))",
  right: "translate(calc(var(--fan) * 34%), calc(var(--fan) * 2%)) rotate(calc(var(--fan) * 9deg))",
  front: "translateY(calc(var(--fan) * -6%)) scale(calc(1 + var(--fan) * 0.04))",
} as const;

const fanned = (transform: string): CSSProperties => ({ transform, willChange: "transform", transition: "transform 120ms linear" });

/**
 * The landing hero's three cards (Time Walk, Black Lotus, Mox Sapphire) with a live bid on top and the 蔵 seal behind.
 * They float gently, fan out as the page scrolls down and fan back in on the way up. Both motions are off for people
 * who prefer reduced motion, leaving the resting layout.
 */
export function HeroCards() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (media?.matches) {
      el.dataset.motion = "reduced";
      return;
    }
    // One update per frame however many scroll events arrive. `pending` gates it rather than the frame id, which is
    // only known after requestAnimationFrame returns.
    let pending = false;
    let frame = 0;
    const update = () => {
      pending = false;
      el.style.setProperty("--fan", String(fanProgress(window.scrollY, FAN_DISTANCE)));
    };
    const onScroll = () => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (pending) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      data-motion="full"
      style={{ "--fan": 0 } as CSSProperties}
      className="relative mx-auto h-[24rem] w-full max-w-[34rem] sm:h-[30rem] lg:mx-0 lg:h-[34rem] lg:max-w-none"
    >
      <span
        lang="ja"
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-[30%] -translate-y-1/2 font-display text-[22rem] leading-none text-shu/[0.12] select-none sm:text-[30rem] lg:text-[36rem]"
      >
        蔵
      </span>
      <div className="absolute top-1/2 left-1/2 w-[clamp(9.5rem,17vw,15.5rem)] -translate-x-[95%] -translate-y-[40%] -rotate-[16deg]">
        <div style={fanned(spread.left)}>
          <div className="kura-float [animation-delay:-2s]">
            <CardArt src="/cards/time-walk.webp" alt="" loading="eager" className="w-full brightness-90" />
          </div>
        </div>
      </div>
      <div className="absolute top-1/2 left-1/2 w-[clamp(9.5rem,17vw,15.5rem)] translate-x-[18%] -translate-y-[52%] rotate-[14deg]">
        <div style={fanned(spread.right)}>
          <div className="kura-float [animation-delay:-4s]">
            <CardArt src="/cards/mox-sapphire.webp" alt="" loading="eager" className="w-full brightness-90" />
          </div>
        </div>
      </div>
      <div className="absolute top-1/2 left-1/2 w-[clamp(10.5rem,18vw,15.5rem)] -translate-x-[42%] -translate-y-[62%]">
        <div style={fanned(spread.front)}>
          <div className="kura-float">
            <CardArt src="/cards/black-lotus.webp" alt="" loading="eager" className="w-full shadow-[0_30px_70px_#000000c0]" />
          </div>
        </div>
      </div>
      <div className="absolute top-[72%] left-1/2 flex -translate-x-[48%] items-center gap-2.5 rounded-lg border border-border bg-bg/90 px-3.5 py-2 text-[13px] whitespace-nowrap text-text shadow-toast backdrop-blur">
        <GavelIcon className="size-4 text-kin" />
        <span className="font-mono text-[12px]">kenji.kura.eth</span> bid $1,712 per shard
        <span className="text-[11px] text-muted-foreground">2s</span>
      </div>
    </div>
  );
}
