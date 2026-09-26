/**
 * Below this appraiser signer balance, the background ENS appraisal writers (the daily cron and the MultiBaas webhook)
 * write nothing, leaving the ETH to buyout appraisals. Its own module so both import it without pulling in the cron
 * route (or tripping over test mocks of lib/appraise).
 */
export const MIN_SIGNER_BALANCE_WEI = 3_000_000_000_000_000n; // 0.003 ETH
