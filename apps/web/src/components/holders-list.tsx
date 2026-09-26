"use client";

import Link from "next/link";
import { AddressName } from "@/components/address-name";
import { RedemptionMeter, StatTile } from "@/components/kura";
import { ago, pct, toClaimColor, type HolderRow, type HoldersView, type Since, type ToClaimRow } from "@/lib/card-view";
import { money, shardsFixed } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The muted chip on a winning bidder whose shards are still in the auction. */
const ToClaimChip = () => <span className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground">To claim</span>;

const Name = ({ address, className }: { address: string; className?: string }) => (
  <AddressName address={address} avatar={false} copyable={false} maxWidthClassName="max-w-[12rem]" className={className} />
);

function SinceCell({ since, now }: { since: Since; now: number }) {
  if (!since) return <span className="text-muted-foreground">n/a</span>;
  const when = ago(since.timestamp, now);
  if (since.kind === "from") {
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        {when} · from <AddressName address={since.from} avatar={false} copyable={false} maxWidthClassName="max-w-[8rem]" className="[&>span]:font-sans [&>span]:text-[12px] [&>span]:text-text-2" />
      </span>
    );
  }
  return <span>{when} · {since.kind}</span>;
}

/** The Holders tiles' values are 18px (oezcX), smaller than the StatTile default. */
const TILE = "[&>div:nth-child(2)]:text-[18px]";

/**
 * The Holders tab (oezcX): four stat tiles, then one row per holder with share bar, value at clearing and since.
 * `whole`: the card was never sharded, so it has one owner and no shards.
 */
export function HoldersList({ view, now, whole, buyout }: {
  view: HoldersView;
  now: number;
  whole: boolean;
  /** A whole card that was bought out: when, and where its activity is. */
  buyout?: { at: string | null; href: string } | null;
}) {
  if (whole || view.supply === 0n) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-6">
        <h3 className="text-[16px] font-semibold text-text">{buyout ? "Whole, one owner" : "Not sharded, one owner"}</h3>
        {buyout ? (
          <Link href={buyout.href} scroll={false} className="mt-1 block text-[13px] text-text-2 underline-offset-2 hover:text-text hover:underline">
            {`Bought out${buyout.at ? ` on ${buyout.at}` : ""} · minority holders claim payouts`}
          </Link>
        ) : (
          <p className="mt-1 text-[13px] text-text-2">This card is whole. Holders appear once its owner splits it into shards.</p>
        )}
      </div>
    );
  }
  const { rows, top, toClaim, holderCount } = view;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile className={TILE} label="Holders" value={`${holderCount} wallet${holderCount === 1 ? "" : "s"}`} />
        <StatTile
          className={TILE}
          label="Top holder"
          value={top ? <span className="inline-flex max-w-full min-w-0 items-center gap-2">{pct(top.share)} · <Name address={top.holder} className="min-w-0 [&>span]:text-[18px]" /></span> : "n/a"}
        />
        <StatTile className={TILE} label="Concentration" value={`HHI ${view.hhi.toFixed(2)}`} />
        <StatTile className={TILE} label="Unclaimed in auction" value={`${shardsFixed(view.unclaimed)} shards`} />
      </div>
      <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
        <table className="w-full min-w-[760px] text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[12px] text-muted-foreground">
              <th className="px-5 py-3 font-normal">#</th>
              <th className="px-3 py-3 font-normal">Holder</th>
              <th className="px-3 py-3 font-normal">Shards</th>
              <th className="px-3 py-3 font-normal">Share</th>
              <th className="px-3 py-3 font-normal">Value at clearing</th>
              <th className="px-5 py-3 font-normal">Since</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <HolderTr key={r.holder} row={r} rank={i + 1} now={now} />
            ))}
            {toClaim.map((r, i) => (
              <ToClaimTr key={`claim-${r.holder}`} row={r} rank={rows.length + i + 1} color={toClaimColor(rows.length + i)} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-text-2">
        The auction contract and the vault are excluded. Redemption needs one holder at 80% or more.
        {rows.some((r) => r.isPool) && " The Uniswap pool holds shards anyone can buy, outside liquidity included; it never redeems."}
        {toClaim.length > 0 && " To claim: shards won at auction, still in the auction contract until the bidder claims them (estimated at the clearing until the bid exits)."}
      </p>
    </div>
  );
}

function HolderTr({ row, rank, now }: { row: HolderRow; rank: number; now: number }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-5 py-3.5 text-muted-foreground">{rank}</td>
      <td className="px-3 py-3.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
          <Name address={row.holder} />
          {row.isPool && <span data-pool className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground">for sale to anyone</span>}
          {row.canRedeem && <span className="rounded-md bg-kin-soft px-2 py-0.5 text-[11px] font-semibold text-kin">can redeem</span>}
        </span>
      </td>
      <td className="px-3 py-3.5 font-mono text-text">{shardsFixed(row.balance)}</td>
      <td className="px-3 py-3.5">
        <span className="flex items-center gap-3">
          <span className="h-1.5 w-full max-w-[260px] min-w-[120px] overflow-hidden rounded-full bg-bg">
            <span className="block h-full rounded-full" style={{ width: `${row.share * 100}%`, background: row.color }} />
          </span>
          <span className="w-12 font-mono text-[12px] text-text-2">{pct(row.share)}</span>
        </span>
      </td>
      <td className="px-3 py-3.5 font-mono text-text">{row.value == null ? "n/a" : money(row.value, 0)}</td>
      <td className="px-5 py-3.5 text-[12px] whitespace-nowrap text-text-2"><SinceCell since={row.since} now={now} /></td>
    </tr>
  );
}

function ToClaimTr({ row, rank, color }: { row: ToClaimRow; rank: number; color: string }) {
  return (
    <tr className="border-b border-border text-text-2 last:border-0" data-to-claim>
      <td className="px-5 py-3.5 text-muted-foreground">{rank}</td>
      <td className="px-3 py-3.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
          <Name address={row.holder} />
          <ToClaimChip />
        </span>
      </td>
      <td className="px-3 py-3.5 font-mono">{shardsFixed(row.balance)}</td>
      <td className="px-3 py-3.5">
        <span className="flex items-center gap-3">
          <span className="h-1.5 w-full max-w-[260px] min-w-[120px] overflow-hidden rounded-full bg-bg">
            <span className="block h-full rounded-full" style={{ width: `${row.share * 100}%`, background: color }} />
          </span>
          <span className="w-12 font-mono text-[12px]">{pct(row.share)}</span>
        </span>
      </td>
      <td className="px-3 py-3.5 font-mono">{row.value == null ? "n/a" : money(row.value, 0)}</td>
      <td className="px-5 py-3.5 text-[12px] whitespace-nowrap">won at auction</td>
    </tr>
  );
}

/** A ring chart of holder shares (s-series colours in holder order), with the top share in the middle. */
export function OwnershipDonut({ segments, center, sub }: { segments: { share: number; color: string }[]; center: string; sub: string }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const gap = segments.length > 1 ? 3 : 0;
  // Each segment starts where the previous ones end.
  const starts = segments.map((_, i) => segments.slice(0, i).reduce((a, s) => a + s.share * c, 0));
  return (
    <div className="relative size-[132px] shrink-0">
      <svg viewBox="0 0 132 132" className="size-full -rotate-90" aria-hidden>
        <circle cx="66" cy="66" r={r} fill="none" stroke="var(--kura-surface-2)" strokeWidth="16" />
        {segments.map((s, i) => {
          const len = Math.max(0, s.share * c - gap);
          return <circle key={i} cx="66" cy="66" r={r} fill="none" stroke={s.color} strokeWidth="16" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-starts[i]!} />;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-[22px] text-text">{center}</span>
        <span className="text-[11px] text-text-2">{sub}</span>
      </div>
    </div>
  );
}

/**
 * Overview's Ownership block: donut, legend and the "Distance to redemption" meter. A whole card shows its one owner
 * at 100% (`owner`), without the meter.
 */
export function OwnershipSummary({ view, owner, className }: { view: HoldersView; owner: string | null; className?: string }) {
  const whole = view.supply === 0n;
  const rows = whole ? [] : view.rows.slice(0, 6);
  const top = view.top;
  const others = top ? view.supply - top.balance : 0n;
  return (
    <section className={cn("flex flex-col gap-4", className)}>
      <h2 className="font-display text-[24px] font-semibold text-text">Ownership</h2>
      <div className="flex flex-wrap items-center gap-6">
        {whole ? (
          <OwnershipDonut segments={[{ share: 1, color: "var(--kura-kin)" }]} center="100%" sub="one owner" />
        ) : (
          <OwnershipDonut
            segments={[...view.rows.map((r) => ({ share: r.share, color: r.color })), ...view.toClaim.map((r, i) => ({ share: r.share, color: toClaimColor(view.rows.length + i) }))]}
            center={top ? `${Math.round(top.share * 100)}%` : "0%"}
            sub="top holder"
          />
        )}
        <ul className="flex min-w-0 flex-1 flex-col gap-3">
          {whole && owner && (
            <li className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2.5"><span aria-hidden className="size-2 shrink-0 rounded-full bg-kin" /><Name address={owner} /></span>
              <span className="font-mono text-[13px] whitespace-nowrap text-text-2">whole · 100%</span>
            </li>
          )}
          {rows.map((r) => (
            <li key={r.holder} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2.5"><span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: r.color }} /><Name address={r.holder} /></span>
              <span className="font-mono text-[13px] whitespace-nowrap text-text-2">{shardsFixed(r.balance)} · {pct(r.share)}</span>
            </li>
          ))}
          {!whole && view.toClaim.slice(0, Math.max(0, 6 - rows.length)).map((r, i) => (
            <li key={`claim-${r.holder}`} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2.5"><span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: toClaimColor(view.rows.length + i) }} /><Name address={r.holder} /><ToClaimChip /></span>
              <span className="font-mono text-[13px] whitespace-nowrap text-text-2">{shardsFixed(r.balance)} · {pct(r.share)}</span>
            </li>
          ))}
          {!whole && view.rows.length === 0 && view.toClaim.length === 0 && <li className="text-[13px] text-text-2">No holders yet: every shard is still in the auction.</li>}
        </ul>
      </div>
      {!whole && (
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4">
          <RedemptionMeter
            value={top?.share ?? 0}
            label={<span className="font-semibold text-text">Distance to redemption</span>}
            status={top?.canRedeem ? `Eligible · ${pct(top.share)} ≥ 80%` : `${pct(top?.share ?? 0)} · needs 80%`}
            fillClassName="bg-[linear-gradient(90deg,var(--kura-kin),var(--kura-s7))]"
          />
          <p className="text-[12px] text-text-2">
            {top?.canRedeem
              ? `The top holder can buy out the other ${shardsFixed(others, others % 10n ** 18n === 0n ? 0 : 1)} shards and take the physical card.`
              : "One holder needs 80% of the shards to buy out the rest and take the physical card."}
          </p>
        </div>
      )}
    </section>
  );
}
