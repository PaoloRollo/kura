"use client";

import type * as React from "react";
import { Bar, BarChart, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ALPHA, SERIES, hhmm, usd } from "@/lib/chart-colors";
import { ChartFrame, SwatchNote } from "./chart-frame";
import { ChartTip } from "./chart-tip";

export type PricePoint = { t: number; clearing: number };
/** A chip over the bar nearest `t`: "S" settle, "A" appraisal, "B" buyout. */
export type PriceMark = { t: number; label: string };

type Row = PricePoint & { after: boolean; mark: string | null };

function nearest(points: PricePoint[], t: number): number {
  let best = 0;
  for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.t - t) < Math.abs(points[best]!.t - t)) best = i;
  return best;
}

/** The domain the bars sit in: headroom above the top, and a floor below the lowest bar so the climb reads. */
export function priceDomain(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi === lo) return [0, hi * 1.1 || 1];
  const span = hi - lo;
  return [Math.max(0, lo - span * 0.7), hi + span * 0.08];
}

function Chip(props: { x?: number | string; y?: number | string; width?: number | string; value?: unknown }) {
  if (!props.value) return null;
  const x = Number(props.x) + Number(props.width) / 2;
  const y = Number(props.y);
  return (
    <g aria-label={String(props.value)}>
      <rect x={x - 9} y={y - 21} width={18} height={15} rx={3} fill={SERIES.s4} />
      <text x={x} y={y - 10.5} textAnchor="middle" fontSize={9} fontWeight={700} fontFamily="var(--font-mono)" fill="var(--kura-kin-ink)">
        {String(props.value)}
      </text>
    </g>
  );
}

/**
 * Price per shard (LqnA2): one bar per sample in s1 at 67%, flat at the final clearing at 25% after the settle, chips
 * for settle / appraisal / buyout, the market as an s2 reference line when it falls inside the range, and always as a
 * footer note. One y-axis, USD per shard.
 */
export function PriceBars({ points, marks = [], settledAt, market = null, footer, height = 220 }: {
  points: PricePoint[];
  marks?: PriceMark[];
  /** Samples after this time are drawn faded (the price is final). */
  settledAt?: number;
  market?: number | null;
  footer?: React.ReactNode;
  height?: number;
}) {
  const byIndex = new Map(points.length ? marks.map((m) => [nearest(points, m.t), m.label]) : []);
  const rows: Row[] = points.map((p, i) => ({ ...p, after: settledAt != null && p.t > settledAt, mark: byIndex.get(i) ?? null }));
  const [lo, hi] = priceDomain(points.map((p) => p.clearing));
  const marketInRange = market != null && market >= lo && market <= hi;
  return (
    <ChartFrame
      title="Price per shard"
      subtitle="Auction clearing against market, appraisal and buyout marked"
      legend={[{ label: "Clearing", color: SERIES.s1 }, { label: "Market", color: SERIES.s2 }]}
      table={{ columns: ["Time", "Clearing $ / shard"], rows: points.map((p) => [hhmm(p.t), usd(p.clearing, 2)]) }}
      footer={footer ?? (market != null && <SwatchNote color={SERIES.s2}>Market {usd(market, 2)} / shard, flat over the window</SwatchNote>)}
    >
      <div style={{ height }} role="img" aria-label={`Clearing price per shard over ${points.length} samples`}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height }}>
          <BarChart data={rows} margin={{ top: 26, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
            <XAxis dataKey="t" hide />
            <YAxis
              domain={[lo, hi]}
              allowDataOverflow
              tickCount={3}
              width={52}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--kura-muted)", fontSize: 10, fontFamily: "var(--font-mono)" }}
              tickFormatter={(v: number) => usd(v)}
            />
            <Tooltip
              cursor={{ fill: "var(--kura-surface-2)", opacity: 0.6 }}
              isAnimationActive={false}
              content={({ active, payload }) => {
                const row = active ? (payload?.[0]?.payload as Row | undefined) : undefined;
                return row ? <ChartTip label={hhmm(row.t)} value={`${usd(row.clearing, 2)} / shard`} /> : null;
              }}
            />
            {marketInRange && <ReferenceLine y={market} stroke={SERIES.s2} strokeWidth={1.5} strokeDasharray="4 3" />}
            <Bar dataKey="clearing" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {rows.map((r) => <Cell key={r.t} fill={r.after ? ALPHA.s1_25 : ALPHA.s1_67} />)}
              <LabelList dataKey="mark" content={Chip} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
