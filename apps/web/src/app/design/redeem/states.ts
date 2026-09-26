/** The /design/redeem preview states. */
export const REDEEM_PREVIEWS = [
  "quote", "not-graduated", "snapshot", "no-usdc", "no-price", "expired", "full", "below", "page",
  "redeemed", "payout", "payout-banner", "payout-claimed", "send", "send-unknown",
] as const;
export type RedeemPreviewState = (typeof REDEEM_PREVIEWS)[number];
