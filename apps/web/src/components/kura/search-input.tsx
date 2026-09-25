import type * as React from "react";
import { SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type SearchInputProps = Omit<React.ComponentProps<"input">, "size"> & {
  /** Keyboard hint shown at the end, e.g. "/" or "↵". */
  kbd?: React.ReactNode;
  /** Mono text, for queries echoed back as typed (the station's Scryfall search). */
  mono?: boolean;
  /** Box class, for layout tweaks on the wrapper. */
  boxClassName?: string;
};

/** Input/Search: surface box, search icon, 14px placeholder. Focus draws the shu border. */
export function SearchInput({ kbd, mono, className, boxClassName, placeholder = "Search cards, sets or ENS names", ...props }: SearchInputProps) {
  return (
    <label
      data-slot="search-input"
      className={cn(
        "flex w-full cursor-text items-center gap-2.5 rounded-lg border border-border bg-surface px-4 py-[13px] transition-colors focus-within:border-shu",
        boxClassName,
      )}
    >
      <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <input
        type="search"
        placeholder={placeholder}
        className={cn(
          "w-full min-w-0 bg-transparent text-[14px] text-text outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden",
          mono && "font-mono",
          className,
        )}
        {...props}
      />
      {kbd && (
        <kbd className="shrink-0 rounded-[6px] border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{kbd}</kbd>
      )}
    </label>
  );
}
