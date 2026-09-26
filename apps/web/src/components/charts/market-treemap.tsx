"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CardArt } from "@/components/kura";
import { premiumFill, premiumLabel, premiumTone, usd } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";
import { ChartFrame } from "./chart-frame";

export type TreemapItem = {
  id: string;
  name: string;
  /** Implied value, USD. */
  value: number;
  /** Premium to the Scryfall price as a fraction (0.096 = +9.6%); null when there is no market price. */
  premium: number | null;
  /** `/app/cards/[id]?tab=analytics`. */
  href: string;
  thumb?: string;
  ensName?: string;
};

export type Rect = { x: number; y: number; w: number; h: number };

function worst(row: number[], side: number): number {
  const s = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
}

/** Squarified treemap layout (Bruls, Huizing, van Wijk) of `values`, largest first, into `rect`; same order out. */
export function squarify(values: number[], rect: Rect): Rect[] {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const scale = (rect.w * rect.h) / total;
  const areas = values.map((v) => Math.max(0, v) * scale);
  const out: Rect[] = [];
  let r = { ...rect };
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(r.w, r.h);
    const row = [areas[i]!];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]!], side) <= worst(row, side)) row.push(areas[j++]!);
    const s = row.reduce((a, b) => a + b, 0);
    if (r.w >= r.h) {
      const cw = r.h > 0 ? s / r.h : 0;
      let y = r.y;
      for (const a of row) {
        const h = cw > 0 ? a / cw : 0;
        out.push({ x: r.x, y, w: cw, h });
        y += h;
      }
      r = { x: r.x + cw, y: r.y, w: r.w - cw, h: r.h };
    } else {
      const rh = r.w > 0 ? s / r.w : 0;
      let x = r.x;
      for (const a of row) {
        const w = rh > 0 ? a / rh : 0;
        out.push({ x, y: r.y, w, h: rh });
        x += w;
      }
      r = { x: r.x, y: r.y + rh, w: r.w, h: r.h - rh };
    }
    i = j;
  }
  return out;
}

function Gradient() {
  return (
    <span className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground max-sm:hidden" aria-label="Colour: -25% discount to +25% premium">
      -25%
      <span className="h-1.5 w-40 rounded-full" style={{ background: "linear-gradient(90deg, var(--kura-s2), var(--kura-surface-2), var(--kura-s1))" }} />
      +25%
    </span>
  );
}

function Tile({ item, rect, hero }: { item: TreemapItem; rect: Rect; hero: boolean }) {
  const small = rect.w < 120 || rect.h < 80;
  const thumb = item.thumb && !small;
  return (
    <Link
      href={item.href}
      data-premium={item.premium ?? "n/a"}
      title={`${item.name}: ${usd(item.value)}, ${premiumLabel(item.premium)}`}
      className="flex size-full min-w-0 flex-col justify-between overflow-hidden rounded-lg p-3 transition-[filter] hover:brightness-125 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      style={{ background: premiumFill(item.premium) }}
    >
      <div className={cn("flex min-w-0 items-start", hero ? "gap-3 p-2" : "gap-2.5")}>
        {thumb && <CardArt src={item.thumb!} alt="" className={cn("shrink-0 shadow-none", hero ? "w-[52px]" : "w-6")} />}
        <div className="flex min-w-0 flex-col gap-1">
          <span className={cn("truncate text-text", hero ? "font-display text-[20px] font-semibold" : "text-[13px] font-semibold")}>{item.name}</span>
          {hero && item.ensName && <span className="truncate font-mono text-[11px] text-kin">{item.ensName}</span>}
        </div>
      </div>
      <div className={cn("flex min-w-0 items-end justify-between gap-2", hero && "p-2")}>
        <span className={cn("truncate font-mono text-text", hero ? "text-[30px] leading-none" : "text-[14px]")}>{usd(item.value)}</span>
        {!small && <span className={cn("shrink-0 font-mono", hero ? "text-[14px]" : "text-[11px]", premiumTone(item.premium))}>{premiumLabel(item.premium)}</span>}
      </div>
    </Link>
  );
}

/**
 * Market map (Y1eNn): one tile per card sized by implied value (squarified), filled by premium to the Scryfall price on
 * the s2 / surface-2 / s1 scale, 4px gaps, r8. The largest tile carries the Fraunces name and the ENS name.
 */
export function MarketTreemap({ items, height = 360, title = "Market map", subtitle = "Size is implied value. Color is premium or discount to the Scryfall price." }: {
  items: TreemapItem[];
  height?: number;
  title?: string;
  subtitle?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1344);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(1, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const sorted = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const rects = squarify(sorted.map((i) => i.value), { x: 0, y: 0, w: width, h: height + 4 });
  return (
    <ChartFrame
      bare
      title={title}
      subtitle={subtitle}
      aside={<Gradient />}
      table={{ columns: ["Card", "Implied value", "Premium"], rows: sorted.map((i) => [i.name, usd(i.value), premiumLabel(i.premium)]) }}
    >
      <div ref={ref} className="relative -m-0.5" style={{ height: height + 4 }}>
        {sorted.length === 0 && <p className="py-10 text-center text-[12px] text-muted-foreground">No cards in the vault yet</p>}
        {sorted.map((item, i) => {
          const r = rects[i]!;
          return (
            <div
              key={item.id}
              className="absolute p-0.5"
              style={{ left: `${(r.x / width) * 100}%`, top: r.y, width: `${(r.w / width) * 100}%`, height: r.h }}
            >
              <Tile item={item} rect={r} hero={i === 0 && r.w >= 260 && r.h >= 180} />
            </div>
          );
        })}
      </div>
    </ChartFrame>
  );
}
