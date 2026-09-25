"use client";

import { useState } from "react";
import { orderRecords, recordRole, type RecordRole } from "@/lib/card-view";
import { cn } from "@/lib/utils";

const ROLE_CLASS: Record<RecordRole, string> = {
  vendor: "bg-kin-soft text-kin",
  appraiser: "bg-s7/15 text-s7",
  vault: "bg-surface-2 text-text-2",
};

/** Rows shown before "Show all": the design's five priority keys. */
const COLLAPSED = 5;

/**
 * The On-chain profile card: the card name's ENS text records with the role that may write each key. `revoked` (the
 * name was revoked on release) turns the header into "revoked · read-only history".
 */
export function EnsRecords({ records, revoked = false, className }: {
  records: readonly { key: string; value: string }[];
  revoked?: boolean;
  className?: string;
}) {
  const [all, setAll] = useState(false);
  const ordered = orderRecords(records);
  const shown = all ? ordered : ordered.slice(0, COLLAPSED);
  return (
    <section aria-label="On-chain profile" className={cn("flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5", className)}>
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-[14px] font-semibold text-text">On-chain profile</h3>
        {revoked ? (
          <span className="font-mono text-[11px] text-shu">revoked · read-only history</span>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground">ENSv2 · Sepolia</span>
        )}
      </header>
      {ordered.length === 0 ? (
        <p className="text-[13px] text-text-2">No records yet.</p>
      ) : (
        <dl className="flex flex-col">
          {shown.map((r) => {
            const role = recordRole(r.key);
            return (
              <div key={r.key} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3 py-1.5">
                <dt className="truncate font-mono text-[12px] text-muted-foreground" title={r.key}>{r.key}</dt>
                <dd className="truncate font-mono text-[12px] text-text" title={r.value}>{r.value}</dd>
                <span className={cn("rounded-md px-2 py-0.5 text-[11px]", ROLE_CLASS[role])}>{role}</span>
              </div>
            );
          })}
        </dl>
      )}
      {ordered.length > COLLAPSED && (
        <button type="button" onClick={() => setAll((v) => !v)} className="w-fit text-[12px] text-text-2 underline-offset-2 hover:text-text hover:underline">
          {all ? "Show fewer" : `Show all ${ordered.length} records`}
        </button>
      )}
      <p className="text-[11px] text-text-2">Each party can only write its own keys (Enhanced Access Control).</p>
    </section>
  );
}
