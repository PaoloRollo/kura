"use client";

import { useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { RotateCcwIcon } from "lucide-react";
import { CardArt } from "@/components/kura";
import type { Finish } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/** Most the card tilts toward the pointer, in degrees. */
const MAX_TILT = 8;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The tilt and glare for a pointer at (x, y) inside a w × h card: flat at the centre, up to MAX_TILT at the edges with
 * the edge under the pointer coming toward the viewer, and the glare centred on the pointer (percent of the card).
 */
export function tiltAt(x: number, y: number, w: number, h: number): { rx: number; ry: number; gx: number; gy: number } {
  if (w <= 0 || h <= 0) return { rx: 0, ry: 0, gx: 50, gy: 50 };
  const px = clamp01(x / w);
  const py = clamp01(y / h);
  const round = (v: number) => Math.round(v * 100) / 100 + 0; // + 0 turns -0 into 0
  return { rx: round((0.5 - py) * 2 * MAX_TILT), ry: round((px - 0.5) * 2 * MAX_TILT), gx: round(px * 100), gy: round(py * 100) };
}

export type Certificate = {
  name: string;
  set?: string;
  rarity?: string;
  condition: string;
  language: string;
  ensName?: string | null;
  released: boolean;
};

const FINISH_LABEL: Record<Finish, string> = { nonfoil: "Non-foil", foil: "Foil", etched: "Etched foil" };

/**
 * The card page's art: tilts toward the pointer with a moving glare, shimmers holographically when the card is foil
 * or etched, and flips to its Kura vault certificate on click, tap, Enter or Space. Reduced motion keeps the flip (made
 * instant) and drops the tilt and shimmer (globals.css `.card-showcase`).
 */
export function CardShowcase({ src, alt, finish, certificate, className }: { src: string; alt: string; finish: Finish; certificate: Certificate; className?: string }) {
  const [flipped, setFlipped] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const foil = finish === "nonfoil" ? null : finish;

  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType !== "mouse" || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const t = tiltAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    const s = ref.current.style;
    s.setProperty("--rx", `${t.rx}deg`);
    s.setProperty("--ry", `${t.ry}deg`);
    s.setProperty("--gx", `${t.gx}%`);
    s.setProperty("--gy", `${t.gy}%`);
    s.setProperty("--glare", "1");
  };
  const onLeave = () => {
    const s = ref.current?.style;
    if (!s) return;
    s.setProperty("--rx", "0deg");
    s.setProperty("--ry", "0deg");
    s.setProperty("--glare", "0");
  };

  return (
    <div className={cn("relative mx-auto w-full", className)}>
      {foil && (
        <span data-slot="finish-pill" className="absolute -top-2.5 -right-2.5 z-20 rounded-full border border-kin/40 bg-bg/90 px-2.5 py-1 text-[11px] font-medium text-kin shadow-toast backdrop-blur">
          {FINISH_LABEL[foil]}
        </span>
      )}
      <button
        ref={ref}
        type="button"
        aria-pressed={flipped}
        aria-label={flipped ? `Show card art of ${certificate.name}` : `Show vault certificate of ${certificate.name}`}
        onClick={() => setFlipped((f) => !f)}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        className="card-showcase group block w-full cursor-pointer rounded-[4.5%/3.3%] outline-none [perspective:1200px] focus-visible:ring-2 focus-visible:ring-shu focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
        style={{ "--rx": "0deg", "--ry": "0deg", "--gx": "50%", "--gy": "50%", "--glare": "0" } as CSSProperties}
      >
        <span className="card-showcase-tilt relative block">
          <span className={cn("card-showcase-flip relative block [transform-style:preserve-3d]", flipped && "is-flipped")}>
            <span className="relative block [backface-visibility:hidden]">
              <CardArt src={src} alt={alt} loading="eager" className="w-full" />
              {foil && <span aria-hidden data-foil={foil} className={cn("card-foil pointer-events-none absolute inset-0 rounded-[4.5%/3.3%]", foil === "etched" && "card-foil-etched")} />}
              <span aria-hidden className="card-glare pointer-events-none absolute inset-0 rounded-[4.5%/3.3%]" />
            </span>
            <span
              data-testid="card-back"
              className="absolute inset-0 flex [transform:rotateY(180deg)] flex-col items-center justify-between overflow-hidden rounded-[4.5%/3.3%] border border-border bg-[radial-gradient(ellipse_at_50%_30%,#26262a_0%,#141416_70%)] p-[9%] text-center shadow-[0_14px_34px_#00000080] [backface-visibility:hidden]"
            >
              <span className="text-[10px] tracking-[0.2em] text-muted-foreground uppercase">Kura vault certificate</span>
              <span className="flex flex-col items-center gap-2">
                <span lang="ja" className="font-display text-[64px] leading-none text-shu/80">蔵</span>
                <span className="font-display text-[20px] leading-tight font-semibold text-text">{certificate.name}</span>
                <span className="text-[12px] text-text-2">
                  {[certificate.set, certificate.rarity].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="grid w-full grid-cols-3 gap-2 border-y border-border py-3 text-[11px]">
                <Fact label="Condition" value={certificate.condition} />
                <Fact label="Language" value={certificate.language} />
                <Fact label="Finish" value={FINISH_LABEL[finish]} />
              </span>
              <span className="flex flex-col items-center gap-1">
                {certificate.ensName && <span className="font-mono text-[11px] break-all text-text">{certificate.ensName}</span>}
                <span className="text-[11px] text-muted-foreground">{certificate.released ? "Released from the Kura vault" : "Held in the Kura vault · Tokyo"}</span>
              </span>
            </span>
          </span>
        </span>
      </button>
      <p aria-hidden className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        <RotateCcwIcon className="size-3" />
        {flipped ? "Tap to see the card" : "Tap to see its vault certificate"}
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-text">{value}</span>
    </span>
  );
}
