import { ALPHA, SERIES, usd, usdCompact, weekday } from "@/lib/chart-colors";
import { ChartFrame } from "./chart-frame";

export type DailyPoint = { date: string; value: number };

/**
 * Daily volume (Y1eNn, WABQw): one series, thin 28px bars in s1 at 44% with the latest bucket solid, compact value
 * labels above and weekday labels below. Phones get single-letter weekdays, wider bars and no value labels. Plain divs.
 */
export function DailyBars({ points, label, title = "Daily volume", subtitle = "USDC through auctions and buyouts", height = 150 }: {
  points: DailyPoint[];
  /** The series name, for the table and the accessible label. */
  label: string;
  title?: string;
  subtitle?: string;
  height?: number;
}) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <ChartFrame title={title} subtitle={subtitle} table={{ columns: ["Day", label], rows: points.map((p) => [p.date, usd(p.value)]) }}>
      <div className="flex flex-col gap-2" role="img" aria-label={`${label} per day, latest ${usd(points.at(-1)?.value ?? 0)}`}>
        <div className="flex items-end gap-2 border-b border-border sm:gap-0" style={{ height }}>
          {points.map((p, i) => (
            <div key={p.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5" title={`${weekday(p.date)} ${p.date}: ${usd(p.value)}`}>
              <span className="font-mono text-[10px] text-muted-foreground max-sm:hidden">{usdCompact(p.value)}</span>
              <span
                className="w-full rounded-t-[3px] sm:w-7"
                style={{ height: `${Math.max(1.5, (p.value / max) * 82)}%`, background: i === points.length - 1 ? SERIES.s1 : ALPHA.s1_44 }}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-2 text-[11px] text-muted-foreground sm:gap-0">
          {points.map((p) => (
            <span key={p.date} className="min-w-0 flex-1 text-center">
              <span className="sm:hidden">{weekday(p.date, true)}</span>
              <span className="max-sm:hidden">{weekday(p.date)}</span>
            </span>
          ))}
        </div>
      </div>
    </ChartFrame>
  );
}
