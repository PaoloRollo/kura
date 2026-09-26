export const ANALYTICS_PREVIEWS = ["rich", "quiet-24h", "empty", "loading", "live"] as const;
export type AnalyticsPreviewState = (typeof ANALYTICS_PREVIEWS)[number];
