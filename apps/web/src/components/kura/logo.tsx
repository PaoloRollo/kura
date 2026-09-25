import Link from "next/link";
import { cn } from "@/lib/utils";

/** Wordmark: vermilion 蔵 and "Kura" in Fraunces. */
export function Logo({ href = "/", className, size = "md" }: { href?: string; className?: string; size?: "sm" | "md" }) {
  return (
    <Link
      href={href}
      aria-label="Kura home"
      className={cn("inline-flex shrink-0 items-center gap-2.5 font-display font-semibold text-text outline-none focus-visible:ring-3 focus-visible:ring-ring/50", size === "md" ? "text-[24px]" : "text-[18px]", className)}
    >
      <span lang="ja" className="font-display text-shu">蔵</span>
      <span>Kura</span>
    </Link>
  );
}
