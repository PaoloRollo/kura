import type * as React from "react";
import { holderColor } from "@/lib/card-view";
import { ChartFrame } from "./chart-frame";

export type OwnershipSlice = {
  id: string;
  /** What the list shows: an `AddressName`, usually. */
  label: React.ReactNode;
  /** Plain text for the table and tooltips. */
  name: string;
  value: number;
};

const LISTED = 4;
const OTHER = "var(--kura-muted)";

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

/** Holders in the order given (balance desc): the top four, then "Other" for the rest when it holds anything. */
export function ownershipRows(slices: OwnershipSlice[]) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const share = (v: number) => (total > 0 ? v / total : 0);
  const top = slices.slice(0, LISTED).map((s, i) => ({ ...s, share: share(s.value), color: holderColor(i) }));
  const rest = slices.slice(LISTED).reduce((s, x) => s + x.value, 0);
  return rest > 0 ? [...top, { id: "other", label: "Other", name: "Other", value: rest, share: share(rest), color: OTHER }] : top;
}

/**
 * Ownership split (LqnA2): a 14px stacked bar (r3 segments, 2px gaps) in holder colours, then the list: dot, name,
 * share. Plain divs.
 */
export function OwnershipBar({ slices, title = "Ownership split", subtitle = "Share of live supply" }: {
  slices: OwnershipSlice[];
  title?: string;
  subtitle?: string;
}) {
  const rows = ownershipRows(slices);
  return (
    <ChartFrame title={title} subtitle={subtitle} table={{ columns: ["Holder", "Share"], rows: rows.map((r) => [r.name, pct(r.share)]) }}>
      <div className="flex h-3.5 gap-0.5" role="img" aria-label={rows.map((r) => `${r.name} ${pct(r.share)}`).join(", ")}>
        {rows.filter((r) => r.share > 0).map((r) => (
          <span key={r.id} title={`${r.name} ${pct(r.share)}`} className="h-full min-w-[3px] rounded-[3px]" style={{ flexGrow: r.share, flexBasis: 0, background: r.color }} />
        ))}
      </div>
      <ul className="flex flex-col gap-3.5">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2.5 text-[12px]">
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: r.color }} />
            <span className="min-w-0 flex-1 truncate font-mono text-text">{r.label}</span>
            <span className="font-mono text-text-2">{pct(r.share)}</span>
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}
