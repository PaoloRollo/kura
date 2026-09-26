/** The /design/portfolio preview states: the tabs, the edge cases and My shards. */
export const PORTFOLIO_PREVIEWS = [
  "shards", "whole", "bids", "empty", "empty-tab", "no-handle", "loading", "claimed", "detail-seller", "detail-buyer", "detail-awaiting",
] as const;
export type PortfolioPreviewState = (typeof PORTFOLIO_PREVIEWS)[number];
