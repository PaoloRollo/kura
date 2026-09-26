"use client";

import { useCallback, useSyncExternalStore } from "react";

const supported = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

/**
 * Whether a media query matches. False on the server and through hydration (then the real value), so a component
 * mounted only when it matches never renders, or runs its queries, on a screen it is hidden on.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    if (!supported()) return () => {};
    const m = window.matchMedia(query);
    m.addEventListener("change", cb);
    return () => m.removeEventListener("change", cb);
  }, [query]);
  return useSyncExternalStore(subscribe, () => supported() && window.matchMedia(query).matches, () => false);
}
