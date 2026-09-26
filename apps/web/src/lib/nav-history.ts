// In-app navigation history for mobile back buttons: whether the visit has moved between pages inside the app, so
// router.back() stays inside Kura instead of leaving for wherever the visitor came from (or nowhere, on a deep link).
let last: string | null = null;
let moves = 0;

/** Records the current path; call it on every path change (SiteHeader does). */
export function recordNavigation(path: string) {
  if (path === last) return;
  if (last !== null) moves += 1;
  last = path;
}

/** True once the visitor navigated inside the app at least once. */
export const canGoBack = () => moves > 0;

/** Tests only. */
export function resetNavigation() {
  last = null;
  moves = 0;
}
