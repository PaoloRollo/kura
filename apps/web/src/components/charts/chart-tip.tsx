/** Tooltip body shared by the charts: a text-2 label over a mono value, on surface-2. */
export function ChartTip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-[11px] shadow-toast">
      <div className="text-text-2">{label}</div>
      <div className="font-mono text-text">{value}</div>
    </div>
  );
}
