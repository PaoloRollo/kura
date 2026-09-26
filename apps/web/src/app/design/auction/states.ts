/** The /design/auction preview states: the live bid form, then the auction after its end block. */
export const AUCTION_PREVIEWS = [
  "unverified", "verified", "refused", "expired", "price-moved", "invalid",
  "ended", "ended-reserve", "settled", "settled-reserve", "owner-settled", "no-bids",
] as const;
export type AuctionPreviewState = (typeof AUCTION_PREVIEWS)[number];

export const ENDED_STATES: readonly AuctionPreviewState[] = ["ended", "ended-reserve", "settled", "settled-reserve", "owner-settled", "no-bids"];
