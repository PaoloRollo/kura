export const NOTIFICATION_PREVIEWS = ["rich", "read", "empty"] as const;
export type NotificationPreviewState = (typeof NOTIFICATION_PREVIEWS)[number];
