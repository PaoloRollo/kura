import { ALPHA, SERIES, hhmm } from "@/lib/chart-colors";
import { ChartFrame } from "./chart-frame";

export type HolderPoint = { t: number; holders: number };

/**
 * Holders over time (LqnA2): one bar per point, s3 at 50% with the latest solid, r[3,3,0,0], and a three-label axis
 * ("sharded 14:02 UTC", "settled 14:22 UTC", "now"). Plain divs.
 */
export function HolderBars({ points, shardedAt, settledAt, height = 128 }: {
  points: HolderPoint[];
  shardedAt?: number;
  settledAt?: number;
  height?: number;
}) {
  const max = Math.max(1, ...points.map((p) => p.holders));
  const start = shardedAt ?? points[0]?.t;
  return (
    <ChartFrame
      title="Holders over time"
      subtitle="Distinct wallets holding a shard, auction and vault excluded; unclaimed wins count once claimed"
      table={{ columns: ["Time (UTC)", "Holders"], rows: points.map((p) => [hhmm(p.t), p.holders]) }}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-1.5" style={{ height }} role="img" aria-label={`Holders over time, now ${points.at(-1)?.holders ?? 0}`}>
          {points.map((p, i) => (
            <span
              key={p.t}
              title={`${hhmm(p.t)} UTC: ${p.holders} holder${p.holders === 1 ? "" : "s"}`}
              className="min-w-0 flex-1 rounded-t-[3px]"
              style={{ height: `${Math.max(2, (p.holders / max) * 100)}%`, background: i === points.length - 1 ? SERIES.s3 : ALPHA.s3_50 }}
            />
          ))}
        </div>
        <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
          <span>{start != null ? `sharded ${hhmm(start)} UTC` : ""}</span>
          {settledAt != null && <span>settled {hhmm(settledAt)} UTC</span>}
          <span>now</span>
        </div>
      </div>
    </ChartFrame>
  );
}
