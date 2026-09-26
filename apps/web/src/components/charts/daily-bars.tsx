import { ALPHA, SERIES, usd, usdCompact, weekday } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";
import { ChartFrame } from "./chart-frame";

/** "Sep 12" for a "YYYY-MM-DD" UTC day. */
const dayMonth = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export type DailyPoint = { date: string; value: number };

/**
 * Daily volume (Y1eNn, WABQw): one series, thin 28px bars in s1 at 44% with the latest bucket solid, compact value
 * labels above and weekday labels below. Phones get single-letter weekdays, wider bars and no value labels. Plain divs.
 */
export function DailyBars({ points, label, title = "Daily volume", subtitle = "USDC through auctions and buyouts", height = 150, unit = "day" }: {
  /** `date` is a UTC day "YYYY-MM-DD", or a UTC hour "YYYY-MM-DDTHH" with `unit="hour"` (lib/series buckets). */
  points: DailyPoint[];
  /** The series name, for the table and the accessible label. */
  label: string;
  title?: string;
  subtitle?: string;
  height?: number;
  /** Hourly buckets are labelled "14:00" (UTC). With more than 12 bars the value labels go and the axis thins out. */
  unit?: "day" | "hour";
}) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const dense = points.length > 12;
  const every = dense ? Math.ceil(points.length / 8) : 1;
  const axis = (p: DailyPoint, narrow: boolean) => (unit === "hour" ? `${p.date.slice(11, 13)}:00` : dense || points.length > 7 ? dayMonth(p.date) : weekday(p.date, narrow));
  // Keep the latest label; thin the rest back from it.
  const shown = (i: number) => (points.length - 1 - i) % every === 0;
  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      table={{ columns: [unit === "hour" ? "Hour (UTC)" : "Day (UTC)", label], rows: points.map((p) => [unit === "hour" ? `${p.date.slice(0, 10)} ${p.date.slice(11, 13)}:00` : p.date, usd(p.value)]) }}
    >
      <div className="flex flex-col gap-2" role="img" aria-label={`${label} per ${unit === "hour" ? "hour" : "day"}, latest ${usd(points.at(-1)?.value ?? 0)}`}>
        <div className="flex items-end gap-2 border-b border-border sm:gap-0" style={{ height }}>
          {points.map((p, i) => (
            <div key={p.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5" title={`${unit === "hour" ? `${p.date.slice(0, 10)} ${p.date.slice(11, 13)}:00 UTC` : `${weekday(p.date)} ${p.date}`}: ${usd(p.value)}`}>
              {!dense && <span className="font-mono text-[10px] text-muted-foreground max-sm:hidden">{usdCompact(p.value)}</span>}
              <span
                className={cn("w-full rounded-t-[3px]", dense ? "max-w-7 sm:w-3/5" : "sm:w-7")}
                style={{ height: `${Math.max(1.5, (p.value / max) * 82)}%`, background: i === points.length - 1 ? SERIES.s1 : ALPHA.s1_44 }}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-2 text-[11px] text-muted-foreground sm:gap-0">
          {points.map((p, i) => (
            <span key={p.date} className="flex min-w-0 flex-1 justify-center whitespace-nowrap">
              {shown(i) && (
                <>
                  <span className="sm:hidden">{axis(p, true)}</span>
                  <span className="max-sm:hidden">{axis(p, false)}</span>
                </>
              )}
            </span>
          ))}
        </div>
      </div>
    </ChartFrame>
  );
}
