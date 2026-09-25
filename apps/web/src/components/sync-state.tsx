"use client";

import type * as React from "react";
import { usePonderStatus } from "@ponder/react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";

function StateCard({ label, icon, iconClassName, title, children, className }: {
  label: string;
  icon: React.ReactNode;
  iconClassName?: string;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5", className)}>
      <span className="w-fit rounded-md bg-surface-2 px-2 py-1 text-[10px] font-semibold tracking-[1px] text-text-2 uppercase">{label}</span>
      <span className={cn("flex size-11 items-center justify-center rounded-lg bg-surface-2 [&_svg]:size-5", iconClassName)}>{icon}</span>
      <div className="flex flex-col gap-1.5">
        <h4 className="text-[16px] font-semibold text-text">{title}</h4>
        {children}
      </div>
    </div>
  );
}

const block = (n: bigint) => n.toLocaleString("en-US");

/** The Loading card (mnpO6): "Syncing with the vault · Reading block N…" over skeleton lines. */
export function SyncLoading({ block: n, title = "Syncing with the vault", className }: { block?: bigint | null; title?: string; className?: string }) {
  return (
    <StateCard label="Loading" icon={<Loader2Icon className="animate-spin" />} iconClassName="text-text-2" title={title} className={className}>
      <p className="text-[13px] text-text-2">{n != null ? `Reading block ${block(n)}…` : "Connecting to the indexer…"}</p>
      <div aria-hidden className="mt-2 flex flex-col gap-3">
        <span className="h-2 w-[85%] animate-pulse rounded-full bg-surface-2" />
        <span className="h-2 w-[60%] animate-pulse rounded-full bg-surface-2" />
        <span className="h-2 w-[70%] animate-pulse rounded-full bg-surface-2" />
      </div>
    </StateCard>
  );
}

/** SyncLoading with the block the indexer is on, live from its status. For page loading states. */
export function IndexerLoading({ title, className }: { title?: string; className?: string }) {
  const { data } = usePonderStatus();
  const n = data?.sepolia?.block?.number;
  return <SyncLoading block={n != null ? BigInt(n) : null} title={title} className={className} />;
}

/** The Indexing card (mnpO6): the transaction is mined, the indexer is catching up. `progress` 0..1, omit for indeterminate. */
export function SyncIndexing({
  hash,
  blockNumber,
  progress,
  title = "Confirmed, indexing",
  className,
}: {
  hash: string;
  blockNumber: bigint;
  progress?: number;
  title?: string;
  className?: string;
}) {
  return (
    <StateCard label="Indexing" icon={<RefreshCwIcon className="animate-spin [animation-duration:2s]" />} iconClassName="text-kin" title={title} className={className}>
      <p className="text-[13px] text-text-2">
        Transaction <span className="font-mono">{shortHash(hash)}</span> is in block {block(blockNumber)}. The page updates in a few seconds.
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress != null ? Math.round(progress * 100) : undefined}
        className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className={cn("h-full rounded-full bg-kin transition-[width] duration-500", progress == null && "w-1/3 animate-pulse")}
          style={progress != null ? { width: `${Math.min(1, Math.max(0, progress)) * 100}%` } : undefined}
        />
      </div>
    </StateCard>
  );
}
