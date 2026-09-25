// Pure transaction helpers: no React, no Privy, so node tests and server code can import them.
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeAbiParameters,
  isHex,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { abi } from "@kura/shared";

export type Sent = { hash: Hex; receipt: TransactionReceipt };

// ---------------------------------------------------------------------------------------------------------------------
// Hook data

export type BidTicket = { kind: number; subject: Address; nullifier: bigint; expiresAt: bigint };

/** The BidGateHook's `hookData`: `abi.encode(Ticket ticket, bytes signature)`. */
export function encodeHookData(ticket: BidTicket, signature: Hex): Hex {
  return encodeAbiParameters(
    [
      { type: "tuple", components: [{ name: "kind", type: "uint8" }, { name: "subject", type: "address" }, { name: "nullifier", type: "uint256" }, { name: "expiresAt", type: "uint256" }] },
      { type: "bytes" },
    ],
    [ticket, signature],
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Revert decoding

/**
 * Every custom error a Kura transaction can surface. A call's own ABI misses errors raised deeper in the call
 * (CardNames errors bubbling out of CardVault.mint), so reverts are decoded against all of them.
 */
const ERROR_ABI = [...abi.cardVault, ...abi.ccaAuction, ...abi.cardNames, ...abi.bidGateHook, ...abi.erc20].filter(
  (i) => i.type === "error",
) as Abi;

export type Revert = {
  /** The custom error's name (`Expired`, `ValidationHookCallFailed`), or null when the failure is not a decoded revert. */
  name: string | null;
  args: readonly unknown[];
  /** For `ValidationHookCallFailed(bytes)`: the BidGateHook error inside it. */
  inner?: { name: string; args: readonly unknown[] };
  message: string;
};

/** A failed transaction: the decoded revert (when there is one) and the hash when it was mined and reverted. */
export class TxError extends Error {
  readonly errorName: string | null;
  readonly args: readonly unknown[];
  readonly inner?: { name: string; args: readonly unknown[] };
  readonly hash?: Hex;

  constructor(message: string, opts: { name?: string | null; args?: readonly unknown[]; inner?: Revert["inner"]; hash?: Hex; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "TxError";
    this.errorName = opts.name ?? null;
    this.args = opts.args ?? [];
    this.inner = opts.inner;
    this.hash = opts.hash;
  }
}

function decodeData(data: Hex, errorAbi: Abi): { name: string; args: readonly unknown[] } | null {
  try {
    const r = decodeErrorResult({ abi: errorAbi, data });
    return { name: r.errorName, args: r.args ?? [] };
  } catch {
    return null;
  }
}

function messageOf(e: unknown): string {
  if (e instanceof BaseError) return e.shortMessage || e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Revert data carried somewhere on an error that viem did not wrap (a wallet or RPC error with a `data` field). */
function findRawData(e: unknown): Hex | null {
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 8; depth++) {
    const data = (cur as { data?: unknown }).data;
    if (typeof data === "string" && isHex(data) && data.length >= 10) return data;
    if (data && typeof data === "object" && typeof (data as { data?: unknown }).data === "string") {
      const nested = (data as { data: string }).data;
      if (isHex(nested) && nested.length >= 10) return nested;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Decodes the custom error behind a failed simulation or transaction, including the hook reason inside ValidationHookCallFailed. */
export function decodeRevert(e: unknown): Revert {
  const message = messageOf(e);
  if (e instanceof TxError) return { name: e.errorName, args: e.args, inner: e.inner, message };

  let decoded: { name: string; args: readonly unknown[] } | null = null;
  if (e instanceof BaseError) {
    const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.raw) decoded = decodeData(reverted.raw, ERROR_ABI);
      if (!decoded && reverted.data?.errorName) decoded = { name: reverted.data.errorName, args: reverted.data.args ?? [] };
    }
  }
  if (!decoded) {
    const raw = findRawData(e);
    if (raw) decoded = decodeData(raw, ERROR_ABI);
  }
  if (!decoded) return { name: null, args: [], message };

  let inner: Revert["inner"];
  if (decoded.name === "ValidationHookCallFailed" && typeof decoded.args[0] === "string" && isHex(decoded.args[0])) {
    inner = decodeData(decoded.args[0], abi.bidGateHook as Abi) ?? undefined;
  }
  return { name: decoded.name, args: decoded.args, inner, message };
}

// ---------------------------------------------------------------------------------------------------------------------
// Indexer sync

type StatusOpts = { url?: string; fetchImpl?: typeof fetch };

/** The block the indexer has processed, from `GET {PONDER_URL}/status`, or null while it has none. */
export async function indexedBlock(opts: StatusOpts = {}): Promise<bigint | null> {
  const url = `${opts.url ?? process.env.NEXT_PUBLIC_PONDER_URL ?? "http://localhost:42069"}/status`;
  const f = opts.fetchImpl ?? fetch;
  const json = (await (await f(url)).json()) as Record<string, { block: { number: number } | null } | undefined>;
  const n = json.sepolia?.block?.number;
  return n == null ? null : BigInt(n);
}

/** Polls the indexer until it has processed `blockNumber`. False at the timeout (30 s by default). */
export async function waitForIndexer(
  blockNumber: bigint,
  opts: StatusOpts & { intervalMs?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  const interval = opts.intervalMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    try {
      const n = await indexedBlock(opts);
      if (n != null && n >= blockNumber) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Step runner

export type Step = { id: string; label: string; skip?: () => Promise<boolean>; run: () => Promise<Sent> };
export type StepStatus = "pending" | "running" | "skipped" | "done" | "failed";
export type StepResult = {
  id: string;
  status: StepStatus;
  hash?: Hex;
  blockNumber?: bigint;
  error?: string;
  revert?: Revert;
  cause?: unknown;
};

/**
 * Runs the steps in order, skipping those whose skip() is true and stopping at the first failure.
 * On a retry, pass the previous results: a step that already went through stays done instead of being sent again
 * (its skip(), when it has one, is re-evaluated and decides).
 */
export async function runSteps(
  steps: Step[],
  deps: { onStatus: (results: StepResult[]) => void; previous?: StepResult[] },
): Promise<StepResult[]> {
  const results: StepResult[] = steps.map((s) => ({ id: s.id, status: "pending" }));
  const emit = () => deps.onStatus(results.map((r) => ({ ...r })));
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const before = deps.previous?.find((r) => r.id === s.id && r.status === "done");
    try {
      if (s.skip && (await s.skip())) {
        results[i] = before ? { ...before } : { id: s.id, status: "skipped" };
        emit();
        continue;
      }
      if (before && !s.skip) {
        results[i] = { ...before };
        emit();
        continue;
      }
      results[i] = { id: s.id, status: "running" };
      emit();
      const sent = await s.run();
      results[i] = { id: s.id, status: "done", hash: sent.hash, blockNumber: sent.receipt.blockNumber };
      emit();
    } catch (e) {
      const revert = decodeRevert(e);
      results[i] = {
        id: s.id,
        status: "failed",
        error: revert.message,
        hash: e instanceof TxError ? e.hash : undefined,
        revert,
        cause: e,
      };
      emit();
      break;
    }
  }
  return results;
}
