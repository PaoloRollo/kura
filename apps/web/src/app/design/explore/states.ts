/** The /design/explore preview states. */
export const EXPLORE_PREVIEWS = ["live", "filtered", "no-results", "filters-sheet", "ending-soon", "upcoming", "ended", "list", "empty", "loading"] as const;
export type ExplorePreviewState = (typeof EXPLORE_PREVIEWS)[number];
