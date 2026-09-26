/** The /design/auction preview states. */
export const AUCTION_PREVIEWS = ["unverified", "verified", "refused", "expired", "price-moved", "invalid"] as const;
export type AuctionPreviewState = (typeof AUCTION_PREVIEWS)[number];
