// IDKit renders its modal in a shadow root on a <div data-idkit-shadow-host> appended to <body>, outside any open
// Radix dialog or sheet (the mobile bid sheet). A modal Radix layer then fights it: body has `pointer-events: none`,
// so taps fall through to the sheet's inputs behind the widget, and the sheet's focus trap and outside-click
// dismissal react to every tap and focus inside it. This makes the IDKit layer its own island: it takes pointer
// events again, and its focus and pointer events stop at the host, so the sheet underneath never sees them.

const HOST = "[data-idkit-shadow-host]";
const ISOLATED = ["focusin", "focusout", "pointerdown", "mousedown", "touchstart"] as const;
const stop = (e: Event) => e.stopPropagation();

export function isolateIdkitHost(host: HTMLElement): void {
  if (host.dataset.kuraIsolated) return;
  host.dataset.kuraIsolated = "true";
  host.style.pointerEvents = "auto";
  for (const type of ISOLATED) host.addEventListener(type, stop);
}

let observer: MutationObserver | null = null;

/** Isolates every IDKit host now and as they are added. Idempotent; a no-op on the server. */
export function watchIdkitLayer(): void {
  if (typeof document === "undefined" || observer) return;
  document.querySelectorAll<HTMLElement>(HOST).forEach(isolateIdkitHost);
  observer = new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n instanceof HTMLElement && n.matches(HOST)) isolateIdkitHost(n);
      });
    }
  });
  observer.observe(document.body, { childList: true });
}

/** Moves focus out of the sheet before the widget opens, so the sheet's focus trap has nothing to pull back to. */
export function releaseFocusForIdkit(): void {
  if (typeof document === "undefined") return;
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body) el.blur();
}
