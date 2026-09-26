import { IndexerLoading } from "@/components/sync-state";
import { Skeleton } from "@/components/ui/skeleton";

/** The Analytics tab's loading state; its own module so it can stand in while the tab's chart chunk loads. */
export function CardAnalyticsLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <IndexerLoading title="Loading this card's analytics" className="max-w-md" />
      <Skeleton className="h-[108px] rounded-2xl bg-surface" />
      <div className="grid gap-4 md:grid-cols-[1.74fr_1fr]">
        <Skeleton className="h-[320px] rounded-2xl bg-surface" />
        <Skeleton className="h-[240px] rounded-2xl bg-surface" />
      </div>
      <div className="grid gap-4 md:grid-cols-[1.1fr_1fr_0.64fr]">
        <Skeleton className="h-[270px] rounded-2xl bg-surface" />
        <Skeleton className="h-[230px] rounded-2xl bg-surface" />
        <Skeleton className="h-[250px] rounded-2xl bg-surface" />
      </div>
    </div>
  );
}
