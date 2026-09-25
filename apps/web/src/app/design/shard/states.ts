export const SHARD_PREVIEWS = ["step1", "step2", "step3", "noprice", "invalid", "notowner", "auctioning", "done", "live"] as const;
export type ShardPreviewState = (typeof SHARD_PREVIEWS)[number];
