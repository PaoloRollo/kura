import { SHARE_COLORS } from "@/lib/chart-colors";
import { ChartFrame } from "./chart-frame";

export type ShareRow = { label: string; count: number };

/**
 * "By language" (Y1eNn): label and count on one row, then a 6px track in bg with a fill in s1, s2, s3, s4 by row order,
 * scaled to the largest row. Plain divs.
 */
export function ShareBars({ rows, title = "By language", subtitle = "Cards in vault" }: { rows: ShareRow[]; title?: string; subtitle?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ChartFrame title={title} subtitle={subtitle} table={{ columns: [title.replace(/^By /, "").replace(/^./, (c) => c.toUpperCase()), "Cards"], rows: rows.map((r) => [r.label, r.count]) }}>
      <ul className="flex flex-col gap-4">
        {rows.map((r, i) => (
          <li key={r.label} className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-text-2">{r.label}</span>
              <span className="font-mono text-text">{r.count}</span>
            </div>
            <div className="h-1.5 rounded-full bg-bg">
              <div className="h-full rounded-full" style={{ width: `${(r.count / max) * 100}%`, background: SHARE_COLORS[i % SHARE_COLORS.length] }} />
            </div>
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}
