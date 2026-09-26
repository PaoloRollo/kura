import { notFound } from "next/navigation";
import { NotificationsPreview } from "./preview";
import { NOTIFICATION_PREVIEWS, type NotificationPreviewState } from "./states";

const requestTime = () => Math.floor(Date.now() / 1000);

/** Dev-only: the Notifications panel and the live toasts (RWhQ9) with indexer-shaped fixtures. */
export default async function NotificationsDesignPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await searchParams;
  const s = (NOTIFICATION_PREVIEWS as readonly string[]).includes(String(state)) ? (state as NotificationPreviewState) : "rich";
  return <NotificationsPreview key={s} state={s} now={requestTime()} />;
}
