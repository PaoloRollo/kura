import { CardArt } from "@/components/kura";
import { cn } from "@/lib/utils";

/** Three cards fanned out (Landing hero, Login): Time Walk left, Black Lotus front, Mox Sapphire right. */
export function CardFan({ className, size = "lg" }: { className?: string; size?: "sm" | "md" | "lg" }) {
  const w = size === "lg" ? "w-[clamp(9rem,20vw,15.5rem)]" : size === "md" ? "w-[8.75rem]" : "w-[7.5rem]";
  return (
    <div aria-hidden className={cn("relative flex items-center justify-center", className)}>
      <CardArt src="/cards/time-walk.webp" alt="" className={cn(w, "absolute -translate-x-[48%] translate-y-[6%] -rotate-[14deg] brightness-90")} loading="eager" />
      <CardArt src="/cards/mox-sapphire.webp" alt="" className={cn(w, "absolute translate-x-[52%] translate-y-[2%] rotate-[12deg] brightness-90")} loading="eager" />
      <CardArt src="/cards/black-lotus.webp" alt="" className={cn(w, "relative -translate-y-[4%] shadow-[0_24px_60px_#000000b0]")} loading="eager" />
    </div>
  );
}
