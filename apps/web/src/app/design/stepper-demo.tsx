"use client";

import type { Hex, TransactionReceipt } from "viem";
import { TxProgress, TxStepper } from "@/components/tx-stepper";
import { IndexerLoading, SyncIndexing, SyncLoading } from "@/components/sync-state";
import { TxError, type Revert, type Step } from "@/lib/tx-core";

const HASH_A = "0x3a1c5e0b7d2f94a6c8e1b3d5f7092a4c6e8b0d2f4a6c8e0b1d3f5a7c9e1b39f2";
const HASH_B = "0x8c0d2f4a6c8e0b1d3f5a7c9e1b3d5f7092a4c6e8b0d2f4a6c8e0b1d3f5a711e";
const HASH_C = "0x5d1e3f5a7c9e1b3d5f7092a4c6e8b0d2f4a6c8e0b1d3f5a7c9e1b3d5f709207b";

const LABELS = ["Approve USDC for Permit2", "Allow this auction to pull $500", "Bid $500 at up to $1,760 / shard"];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeSent = async (hash: string) => {
  await wait(1200);
  return { hash: hash as Hex, receipt: { blockNumber: 1n, status: "success" } as TransactionReceipt };
};

let attempts = 0;
const demoSteps: Step[] = [
  { id: "usdc", label: LABELS[0], run: () => fakeSent(HASH_A) },
  { id: "permit2", label: LABELS[1], run: () => fakeSent(HASH_B) },
  {
    id: "bid",
    label: LABELS[2],
    run: async () => {
      await wait(1200);
      // The first attempt reverts with the hook's Expired(); the retry goes through.
      if (attempts++ % 2 === 0) throw new TxError("transaction reverted", { name: "ValidationHookCallFailed", inner: { name: "Expired", args: [] }, hash: HASH_C });
      return { hash: HASH_C as Hex, receipt: { blockNumber: 1n, status: "success" } as TransactionReceipt };
    },
  },
];

const describe = (_e: unknown, r: Revert) =>
  r.inner?.name === "Expired"
    ? { title: "Your World ID ticket expired", body: "Tickets last 24 hours. Your approvals are saved, so only the bid itself needs to be sent again." }
    : { title: "Something went wrong", body: r.message };

/** TxStepper states (hnuVb, g5bcZ), a live run with a scripted revert, and the sync state cards (mnpO6). */
export function StepperDemo() {
  return (
    <>
      <div className="w-[346px] rounded-2xl border border-border bg-surface p-5">
        <TxProgress
          title="Placing your bid"
          rows={[
            { id: "a", label: LABELS[0], status: "done", hash: HASH_A },
            { id: "b", label: LABELS[1], status: "done", hash: HASH_B },
            { id: "c", label: LABELS[2], status: "running" },
            { id: "i", label: "Indexing", status: "pending" },
          ]}
          walletKind="embedded"
        />
      </div>
      <div className="w-[346px] rounded-2xl border border-border bg-surface p-5">
        <TxProgress
          title="Your bid didn't go through"
          rows={[
            { id: "a", label: LABELS[0], status: "done", hash: HASH_A },
            { id: "b", label: LABELS[1], status: "done", hash: HASH_B },
            { id: "c", label: LABELS[2], status: "failed" },
            { id: "i", label: "Indexing", status: "skipped" },
          ]}
          failure={{ ...describe(null, { name: "ValidationHookCallFailed", args: [], inner: { name: "Expired", args: [] }, message: "" }), reverted: "Expired()", hash: HASH_C }}
          retryLabel="Verify and retry"
        />
      </div>
      <div className="w-[346px] rounded-2xl border border-border bg-surface p-5">
        <TxProgress
          title="Placing your bid"
          rows={[
            { id: "a", label: LABELS[0], status: "done", hash: HASH_A },
            { id: "b", label: LABELS[1], status: "confirming", hash: HASH_B },
            { id: "c", label: LABELS[2], status: "pending" },
            { id: "i", label: "Indexing", status: "pending" },
          ]}
          failure={{ title: "Still confirming", body: "The transaction was sent but hasn't been mined yet. Check again in a moment; it won't be sent twice.", hash: HASH_B, confirming: true }}
          retryLabel="Check again"
        />
      </div>
      <div className="w-[346px] rounded-2xl border border-border bg-surface p-5">
        <TxProgress
          title="Placing your bid"
          rows={[
            { id: "a", label: LABELS[0], status: "done", hash: HASH_A },
            { id: "b", label: LABELS[1], status: "done", hash: HASH_B },
            { id: "c", label: LABELS[2], status: "done", hash: HASH_C },
            { id: "i", label: "Indexing", status: "skipped" },
          ]}
          lagging
        />
      </div>
      <div className="flex w-[346px] flex-col gap-2 rounded-2xl border border-border bg-surface p-5">
        <p className="text-[12px] text-text-2">Live: the bid reverts once, then the retry goes through. Below md it opens as a bottom sheet.</p>
        <TxStepper
          steps={demoSteps}
          walletKind="embedded"
          cta="Place bid"
          title="Placing your bid"
          failedTitle="Your bid didn't go through"
          retryLabel="Verify and retry"
          describeError={describe}
        />
      </div>
      <SyncLoading className="w-[320px]" block={7_412_880n} />
      <IndexerLoading className="w-[320px]" />
      <SyncIndexing className="w-[320px]" title="Bid confirmed, indexing" hash="0x9c4a7e3f5a7c9e1b3d5f7092a4c6e8b0d2f4a6c8e0b1d3f5a7c9e1b3d5f70e21" blockNumber={7_412_884n} progress={0.62} />
    </>
  );
}
