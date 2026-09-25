"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CircleIcon, FuelIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button, notify } from "@/components/kura";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { explorerTx } from "@/lib/chain";
import { shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { runSteps, waitForIndexer, type Revert, type Step, type StepResult, type StepStatus } from "@/lib/tx-core";

// ---------------------------------------------------------------------------------------------------------------------
// Presentational panel (hnuVb, g5bcZ)

export type TxRow = { id: string; label: string; status: StepStatus; hash?: string };
export type TxFailure = { title: string; body?: string; reverted?: string; hash?: string };

function RowIcon({ status }: { status: StepStatus }) {
  const base = "flex size-6 shrink-0 items-center justify-center rounded-full [&_svg]:size-3.5";
  if (status === "done") return <span className={cn(base, "bg-good text-white")}><CheckIcon strokeWidth={3} /></span>;
  if (status === "running") return <span className={cn(base, "border-[1.5px] border-shu text-shu")}><Loader2Icon className="animate-spin" /></span>;
  if (status === "failed") return <span className={cn(base, "border-[1.5px] border-shu bg-shu-soft text-shu")}><XIcon strokeWidth={2.5} /></span>;
  return <span className={cn(base, "bg-surface-2 text-text-2 [&_svg]:size-3")}><CircleIcon strokeWidth={2} /></span>;
}

export function TxProgress({
  title,
  rows,
  failure,
  retryLabel = "Retry",
  onCancel,
  onRetry,
  retrying,
  className,
}: {
  title: string;
  rows: TxRow[];
  failure?: TxFailure | null;
  retryLabel?: string;
  onCancel?: () => void;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div data-slot="tx-progress" className={cn("flex flex-col gap-4", className)}>
      <h3 className="font-display text-[24px] leading-tight font-semibold text-text">{title}</h3>
      <ol className="flex flex-col gap-3.5">
        {rows.map((r) => (
          <li key={r.id} data-status={r.status} className="flex min-h-6 items-center gap-3">
            <RowIcon status={r.status} />
            <span
              className={cn(
                "min-w-0 flex-1 text-[14px]",
                r.status === "failed" ? "text-shu" : r.status === "pending" || r.status === "skipped" ? "text-text-2" : "text-text",
              )}
            >
              {r.label}
              {r.status === "skipped" && <span className="text-text-2"> · skipped</span>}
            </span>
            {r.hash && r.status === "done" && (
              <a
                href={explorerTx(r.hash)}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 font-mono text-[12px] text-text-2 hover:text-text hover:underline"
              >
                {shortHash(r.hash)}
              </a>
            )}
          </li>
        ))}
      </ol>
      {failure ? (
        <>
          <div role="alert" className="flex flex-col gap-1.5 rounded-xl border border-shu/30 bg-shu-soft p-3.5">
            <div className="text-[13px] font-semibold text-text">{failure.title}</div>
            {failure.body && <p className="text-[13px] text-text-2">{failure.body}</p>}
            {failure.reverted && (
              <p className="mt-1 font-mono text-[11px] break-all text-text-2">
                Reverted: {failure.reverted}
                {failure.hash && <> · <a href={explorerTx(failure.hash)} target="_blank" rel="noreferrer" className="hover:underline">{shortHash(failure.hash)}</a></>}
              </p>
            )}
          </div>
          <div className="flex gap-2.5">
            <Button variant="secondary" size="md" className="flex-1" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" size="md" className="flex-1" onClick={onRetry} disabled={retrying}>{retryLabel}</Button>
          </div>
        </>
      ) : (
        <p className="flex items-center gap-2.5 rounded-lg bg-surface-2 px-3.5 py-3 text-[12px] text-text-2">
          <FuelIcon className="size-4 shrink-0 text-good" />
          Gas sponsored. Keep this open, about 12 seconds per step.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Stepper

const INDEXING = "indexing";
type Phase = "idle" | "running" | "indexing" | "failed";

const desktopQuery = "(min-width: 768px)";
function useIsDesktop() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(desktopQuery);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(desktopQuery).matches,
    () => true,
  );
}

function defaultDescribe(_e: unknown, revert: Revert): { title: string; body?: string } {
  if (revert.name) return { title: "The contract refused this transaction", body: "Nothing was charged for the failed step. You can try again." };
  if (/reject|denied|cancel/i.test(revert.message)) return { title: "Request cancelled", body: "The transaction was not sent." };
  return { title: "Something went wrong", body: revert.message };
}

export type TxStepperProps = {
  steps: Step[];
  /** The button label that starts the sequence ("Place bid"). */
  cta: string;
  onDone?: (results: StepResult[]) => void;
  onError?: (results: StepResult[], revert: Revert) => void;
  disabled?: boolean;
  /** Heading while the steps run ("Placing your bid"). */
  title?: string;
  /** Heading after a failure ("Your bid didn't go through"). */
  failedTitle?: string;
  /** Retry button label ("Verify and retry"). */
  retryLabel?: string;
  /** Runs before a retry (refresh a ticket, re-verify). Throwing aborts the retry. */
  onRetry?: () => Promise<void> | void;
  onCancel?: () => void;
  /** Turns a failure into the error card's human title and sentence. */
  describeError?: (e: unknown, revert: Revert) => { title: string; body?: string };
  className?: string;
};

/**
 * Runs a multi-transaction sequence: the CTA starts it, each step shows its status and hash, then an Indexing row waits
 * for the indexer to pass the last block and every react-query cache is invalidated.
 * Inline from `md` up; a bottom sheet below.
 */
export function TxStepper({
  steps,
  cta,
  onDone,
  onError,
  disabled,
  title = "Confirming",
  failedTitle = "That didn't go through",
  retryLabel = "Retry",
  onRetry,
  onCancel,
  describeError = defaultDescribe,
  className,
}: TxStepperProps) {
  const queryClient = useQueryClient();
  const isDesktop = useIsDesktop();
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<StepResult[]>([]);
  const [indexStatus, setIndexStatus] = useState<StepStatus>("pending");
  const [failure, setFailure] = useState<TxFailure | null>(null);
  const [retrying, setRetrying] = useState(false);
  const previous = useRef<StepResult[]>([]);

  async function go() {
    setFailure(null);
    setIndexStatus("pending");
    setPhase("running");
    const out = await runSteps(steps, { onStatus: setResults, previous: previous.current });
    previous.current = out;
    const failed = out.find((r) => r.status === "failed");
    if (failed) {
      const revert = failed.revert ?? { name: null, args: [], message: failed.error ?? "failed" };
      const human = describeError(failed.cause, revert);
      const name = revert.inner?.name ?? revert.name;
      setIndexStatus("skipped");
      setFailure({ ...human, reverted: name ? `${name}()` : undefined, hash: failed.hash });
      setPhase("failed");
      notify({ title: failedTitle, body: human.title, tone: "shu", icon: <XIcon /> });
      onError?.(out, revert);
      return;
    }
    const last = [...out].reverse().find((r) => r.status === "done" && r.blockNumber !== undefined);
    if (last?.blockNumber !== undefined) {
      setPhase("indexing");
      setIndexStatus("running");
      const ok = await waitForIndexer(last.blockNumber).catch(() => false);
      setIndexStatus(ok ? "done" : "skipped");
    } else {
      setIndexStatus("skipped");
    }
    await queryClient.invalidateQueries();
    notify({ title: "Transaction confirmed", body: steps.at(-1)?.label, tone: "good", icon: <CheckIcon /> });
    previous.current = [];
    setPhase("idle");
    setResults([]);
    onDone?.(out);
  }

  async function retry() {
    setRetrying(true);
    try {
      await onRetry?.();
    } catch (e) {
      setRetrying(false);
      setFailure((f) => (f ? { ...f, body: e instanceof Error ? e.message : String(e) } : f));
      return;
    }
    setRetrying(false);
    await go();
  }

  function cancel() {
    previous.current = [];
    setPhase("idle");
    setResults([]);
    setFailure(null);
    onCancel?.();
  }

  const rows: TxRow[] = [
    ...steps.map((s, i) => ({ id: s.id, label: s.label, status: results[i]?.status ?? "pending", hash: results[i]?.hash })),
    { id: INDEXING, label: "Indexing", status: indexStatus },
  ];
  const active = phase !== "idle";
  const panel = (
    <TxProgress
      title={phase === "failed" ? failedTitle : title}
      rows={rows}
      failure={phase === "failed" ? failure : null}
      retryLabel={retryLabel}
      onCancel={cancel}
      onRetry={retry}
      retrying={retrying}
    />
  );

  return (
    <div data-slot="tx-stepper" className={cn("flex flex-col gap-3", className)}>
      {active && isDesktop ? (
        panel
      ) : (
        <Button variant="primary" size="md" className="w-full" onClick={go} disabled={disabled || active}>
          {active ? "Working…" : cta}
        </Button>
      )}
      {!isDesktop && (
        <Sheet open={active} onOpenChange={(open) => { if (!open && phase === "failed") cancel(); }}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            className="rounded-t-2xl border-border bg-surface px-5 pt-3 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]"
            onInteractOutside={(e) => { if (phase !== "failed") e.preventDefault(); }}
            onEscapeKeyDown={(e) => { if (phase !== "failed") e.preventDefault(); }}
          >
            <span aria-hidden className="mx-auto h-1 w-9 rounded-full bg-border" />
            <SheetTitle className="sr-only">{phase === "failed" ? failedTitle : title}</SheetTitle>
            <SheetDescription className="sr-only">Transaction progress</SheetDescription>
            {panel}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
