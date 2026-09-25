import type * as React from "react";
import { cn } from "@/lib/utils";

export type CardArtProps = Omit<React.ComponentProps<"img">, "src" | "alt"> & { src: string; alt: string };

/** A Magic card image at the card's own 63:88 ratio, with the rounded corners and drop shadow of a real card. */
export function CardArt({ src, alt, className, ...props }: CardArtProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- card images are local or remote Scryfall art, not optimised
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={cn("aspect-[63/88] rounded-[4.5%/3.3%] object-cover shadow-[0_14px_34px_#00000080]", className)}
      {...props}
    />
  );
}
