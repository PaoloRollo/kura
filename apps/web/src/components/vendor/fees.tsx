"use client";

import { useState } from "react";
import type * as React from "react";
import { CheckIcon, DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { abi } from "@kura/shared";
import { IndexerLoading } from "@/components/sync-state";
import { TxStepper } from "@/components/tx-stepper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useKuraUser } from "@/hooks/use-kura-user";
import { useNow } from "@/hooks/use-now";
import { useAttributes } from "@/hooks/use-explore";
import { useFeeEvents, useVaultCards, useVaultConfig } from "@/hooks/use-vendor-data";
import { addresses, explorerTx, publicClient } from "@/lib/chain";
import { money, shortAddress, shortHash } from "@/lib/format";
import { useSendTx } from "@/lib/tx";
import { cn } from "@/lib/utils";
import { age, feesCsv, feesPerDay } from "@/lib/vendor";

export type LedgerEntry = { id: string; kind: "sale" | "buyout"; cardId: bigint; name?: string; amountUsdc: bigint; timestamp: number };
export type FeeDay = { day: string; sale: bigint; buyout: bigint };

const DAYS = 7;

function KindPill({ kind }: { kind: "sale" | "buyout" }) {
  return (
    <span
      className={cn(
        "inline-flex w-[70px] shrink-0 justify-center rounded-md py-1 text-[12px] font-medium",
        kind === "buyout" ? "bg-s7/15 text-s7" : "bg-s1-soft text-s1-fg",
      )}
    >
      {kind === "buyout" ? "Buyout" : "Sale"}
    </span>
  );
}

/** Stacked sale (s1) and buyout (s7) bars per UTC day. Simple CSS bars until plan 5's chart primitives land. */
function FeeBars({ days }: { days: FeeDay[] }) {
  const max = days.reduce((m, d) => (d.sale + d.buyout > m ? d.sale + d.buyout : m), 0n);
  const pct = (x: bigint) => (max === 0n ? 0 : Number((x * 10_000n) / max) / 100);
  return (
    <div className="flex flex-col gap-4">
      <div className="relative flex h-[168px] items-end gap-2 sm:gap-3" role="img" aria-label="Fees per day for the last seven days">
        {max === 0n && <p className="absolute inset-0 flex items-center justify-center text-[13px] text-muted-foreground">No fees in the last {DAYS} days</p>}
        {days.map((d) => (
          <div
            key={d.day}
            title={`${d.day}: sales ${money(d.sale)}, buyouts ${money(d.buyout)}`}
            className="flex h-full min-w-0 flex-1 flex-col justify-end gap-[2px]"
          >
            {d.buyout > 0n && <div className="rounded-t-[4px] bg-s7" style={{ height: `${pct(d.buyout)}%` }} />}
            <div
              className={cn("bg-s1", d.buyout > 0n ? "" : "rounded-t-[4px]", d.sale === 0n && d.buyout === 0n && "bg-surface-2")}
              style={{ height: d.sale > 0n ? `${pct(d.sale)}%` : d.buyout > 0n ? 0 : "2px" }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-4 text-[12px] text-text-2">
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-[2px] bg-s1" />Auction sales</span>
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-[2px] bg-s7" />Buyouts</span>
      </div>
    </div>
  );
}

function downloadCsv(ledger: LedgerEntry[]) {
  const blob = new Blob([feesCsv(ledger)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kura-fees-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Vendor · Fees (xJ7vz). Presentational; `feeAction` is the vault fee card's Change control. */
export function FeesView({
  total,
  payout,
  feeBps,
  maxFeeBps,
  feeAction,
  feeNote,
  days,
  ledger,
  now,
}: {
  total: bigint;
  payout?: string;
  feeBps?: number;
  maxFeeBps?: number;
  feeAction?: React.ReactNode;
  /** Under the fee: who can change it. */
  feeNote?: React.ReactNode;
  days: FeeDay[];
  ledger: LedgerEntry[];
  now: number;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-[13px] text-text-2">Fees earned</span>
          <span className="truncate font-mono text-[48px] leading-none text-kin md:text-[64px]">{money(total)}</span>
          <span className="text-[13px] text-text-2">
            Paid straight to <span className="font-mono">{payout ? shortAddress(payout) : "…"}</span> at every settle and buyout
          </span>
        </div>
        <section className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-surface p-5 lg:w-[340px]">
          <span className="text-[12px] text-text-2">Vault fee</span>
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[26px] text-text">{feeBps != null ? `${feeBps / 100}%` : "…"}</span>
            {feeAction}
          </div>
          <span className="text-[11px] text-text-2">
            Max {maxFeeBps != null ? `${maxFeeBps / 100}%` : "10%"}. A change applies to every settle and buyout after it.
          </span>
          {feeNote && <span className="text-[11px] text-muted-foreground">{feeNote}</span>}
        </section>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        <section className="flex flex-col gap-6 rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-[15px] font-semibold text-text">Fees per day</h2>
          <FeeBars days={days} />
        </section>

        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="flex items-center justify-between px-5 py-4">
            <h2 className="text-[15px] font-semibold text-text">Ledger</h2>
            <button
              type="button"
              onClick={() => downloadCsv(ledger)}
              disabled={ledger.length === 0}
              className="inline-flex items-center gap-1.5 text-[12px] text-text-2 hover:text-text disabled:opacity-50"
            >
              <DownloadIcon className="size-3.5" />CSV
            </button>
          </div>
          {ledger.length === 0 ? (
            <p className="border-t border-border px-5 py-10 text-center text-[13px] text-text-2">No fees yet. They arrive at every settle and buyout.</p>
          ) : (
            <ul className="max-h-[28rem] overflow-y-auto">
              {ledger.map((e) => (
                <li key={e.id} className="flex items-center gap-3 border-t border-border px-5 py-2.5">
                  <KindPill kind={e.kind} />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-text">{e.name ?? `Card #${e.cardId}`}</span>
                  <span className="font-mono text-[13px] text-text">{money(e.amountUsdc)}</span>
                  <span className="w-9 text-right font-mono text-[12px] text-muted-foreground">{age(e.timestamp, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** The fee change's confirmation: the new fee and its setFee tx, until the vendor closes it. */
export function FeeSaved({ bps, hash, onClose }: { bps: number; hash?: `0x${string}`; onClose: () => void }) {
  return (
    <div role="status" aria-live="polite" className="flex w-full flex-col gap-2 rounded-xl border border-good/40 bg-good-soft p-3">
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-good-fg"><CheckIcon aria-hidden className="size-4" />Vault fee set to {bps / 100}%</span>
      <div className="flex items-center justify-between gap-2">
        {hash ? (
          <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[12px] text-text-2 hover:text-text">
            tx {shortHash(hash)}<ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        ) : <span />}
        <Button variant="secondary" size="compact" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

/** The fee editor, for the vault owner only: `setFee` is onlyOwner. A change ends on FeeSaved. */
function FeeEditor({ feeBps, maxFeeBps, payout, onDone }: { feeBps: number; maxFeeBps: number; payout: `0x${string}`; onDone: () => void }) {
  const { send, walletKind } = useSendTx();
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState(String(feeBps / 100));
  const [saved, setSaved] = useState<{ bps: number; hash?: `0x${string}` } | null>(null);
  const bps = Math.round(Number(pct) * 100);
  const valid = pct.trim() !== "" && Number.isFinite(bps) && bps >= 0 && bps <= maxFeeBps;
  if (saved) return <FeeSaved bps={saved.bps} hash={saved.hash} onClose={() => setSaved(null)} />;
  if (!open) {
    return <Button variant="secondary" size="compact" onClick={() => setOpen(true)}>Change</Button>;
  }
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input aria-label="New vault fee in percent" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} className="h-9 font-mono" />
        <span className="text-[13px] text-text-2">%</span>
        <Button variant="ghost" size="compact" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <TxStepper
        cta="Save fee"
        walletKind={walletKind}
        title="Updating the fee"
        disabled={!valid || bps === feeBps}
        steps={[
          {
            id: "set-fee",
            label: `Set the vault fee to ${bps / 100}%`,
            skip: async () => (await publicClient.readContract({ address: addresses.cardVault, abi: abi.cardVault, functionName: "feeBps" })) === bps,
            run: () => send({ to: addresses.cardVault, abi: abi.cardVault, functionName: "setFee", args: [bps, payout] }),
          },
        ]}
        onDone={(results) => {
          setOpen(false);
          setSaved({ bps, hash: results.find((r) => r.id === "set-fee")?.hash as `0x${string}` | undefined });
          onDone();
        }}
      />
    </div>
  );
}

/** The Fees screen, live from the indexer and the vault. */
export function Fees() {
  const fees = useFeeEvents();
  const config = useVaultConfig();
  const { address } = useKuraUser();
  const now = useNow();
  // Names in one batched attributes request (by the cards' printings), not one /api/meta call per card.
  const cards = useVaultCards();
  const printingOf = new Map((cards.data ?? []).map((c) => [c.id, c.scryfallId]));
  const feeCards = new Set((fees.data ?? []).map((f) => f.cardId));
  const attributes = useAttributes([...feeCards].flatMap((id) => printingOf.get(id) ?? []));

  if (fees.error) return <p className="py-12 text-center text-[14px] text-text-2">The indexer can&apos;t be reached right now. Try again in a moment.</p>;
  if (!fees.data) return <IndexerLoading title="Loading fees" className="mx-auto w-full max-w-md" />;

  const isOwner = !!address && !!config.owner && address.toLowerCase() === config.owner.toLowerCase();
  const ledger: LedgerEntry[] = fees.data.map((f) => {
    const name = attributes[printingOf.get(f.cardId) ?? ""]?.name;
    return { id: f.id, kind: f.kind, cardId: f.cardId, name: name || undefined, amountUsdc: f.amountUsdc, timestamp: f.timestamp };
  });
  const feeAction =
    isOwner && config.feeBps != null && config.maxFeeBps != null && config.payout ? (
      <FeeEditor feeBps={config.feeBps} maxFeeBps={config.maxFeeBps} payout={config.payout} onDone={() => void config.refetch()} />
    ) : (
      <Button variant="secondary" size="compact" disabled title="Set by the vault owner">Change</Button>
    );
  return (
    <FeesView
      total={fees.data.reduce((a, f) => a + f.amountUsdc, 0n)}
      payout={config.payout}
      feeBps={config.feeBps}
      maxFeeBps={config.maxFeeBps}
      feeAction={feeAction}
      feeNote={!isOwner && config.owner ? <>Set by the vault owner, <span className="font-mono">{shortAddress(config.owner)}</span></> : undefined}
      days={feesPerDay(fees.data, DAYS, now)}
      ledger={ledger}
      now={now}
    />
  );
}
