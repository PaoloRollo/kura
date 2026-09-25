// Pure transaction helpers: no React, no Privy, so node tests and server code can import them.
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  isHex,
  parseAbi,
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
/** Permit2's custom errors (Uniswap permit2 src: AllowanceTransfer, SignatureTransfer, SignatureVerification, ...). */
const PERMIT2_ERRORS = parseAbi([
  "error AllowanceExpired(uint256 deadline)",
  "error InsufficientAllowance(uint256 amount)",
  "error ExcessiveInvalidation()",
  "error InvalidAmount(uint256 maxAmount)",
  "error LengthMismatch()",
  "error InvalidNonce()",
  "error SignatureExpired(uint256 signatureDeadline)",
  "error InvalidSignature()",
  "error InvalidSigner()",
  "error InvalidContractSignature()",
  "error InvalidSignatureLength()",
  "error UnsafeCast()",
]);

const ERROR_ABI = [
  ...[...abi.cardVault, ...abi.ccaAuction, ...abi.cardNames, ...abi.bidGateHook, ...abi.erc20].filter((i) => i.type === "error"),
  ...PERMIT2_ERRORS,
] as Abi;

export type Revert = {
  /** The custom error's name (`Expired`, `ValidationHookCallFailed`), or null when the failure is not a decoded revert. */
  name: string | null;
  args: readonly unknown[];
  /** For `ValidationHookCallFailed(bytes)`: the BidGateHook error inside it. */
  inner?: { name: string; args: readonly unknown[] };
  message: string;
  /** Set when the transaction was broadcast (mined and reverted, or still confirming). No hash: nothing was sent. */
  hash?: Hex;
};

/** A failed transaction: the decoded revert (when there is one) and the hash when it was mined and reverted. */
export class TxError extends Error {
  readonly errorName: string | null;
  readonly args: readonly unknown[];
  readonly inner?: { name: string; args: readonly unknown[] };
  readonly hash?: Hex;
  /** Broadcast, but no receipt yet: it may still be mined. Never re-send; poll the hash instead. */
  readonly pending: boolean;

  constructor(
    message: string,
    opts: { name?: string | null; args?: readonly unknown[]; inner?: Revert["inner"]; hash?: Hex; pending?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "TxError";
    this.errorName = opts.name ?? null;
    this.args = opts.args ?? [];
    this.inner = opts.inner;
    this.hash = opts.hash;
    this.pending = opts.pending ?? false;
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
  if (e instanceof TxError) return { name: e.errorName, args: e.args, inner: e.inner, message, hash: e.hash };

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
// Sending

export type SendInput = { to: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint };
export type UnsignedTx = { to: Address; data: Hex; value: bigint; chainId: number };

export type SenderDeps = {
  account: Address | undefined;
  /** Whether `account` is a Privy embedded wallet; only those can send (and be sponsored) through Privy. */
  embedded: boolean;
  simulate: (req: { account: Address; address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint }) => Promise<unknown>;
  sendTransaction: (tx: UnsignedTx, opts: { sponsor: boolean }) => Promise<{ hash: Hex }>;
  waitForReceipt: (hash: Hex) => Promise<TransactionReceipt>;
};

export const NO_GAS_MESSAGE = "Gas sponsorship isn't available right now and this wallet has no Sepolia ETH for gas.";
export const NO_EMBEDDED_MESSAGE =
  "Kura sends transactions from your Kura wallet with gas sponsored, and this login has none. Log in with email or Google to get one.";
export const NOT_LOGGED_IN_MESSAGE = "Log in to send transactions.";

const SPONSOR_CODES = new Set(["policy_violation", "insufficient_funds", "too_many_requests"]);

/**
 * Errors from Privy's sponsored send that mean "sponsorship can't pay for this one", raised before any hash exists:
 * the TEE-only / sign-request guards, "Unable to sign transaction" (no hash in the wallet RPC response), and
 * PrivyApiError policy, quota and rate-limit responses (`code` from @privy-io/api-base's PrivyErrorCode).
 */
export function isSponsorUnavailable(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const { message, error, code, status } = e as { message?: unknown; error?: unknown; code?: unknown; status?: unknown };
  if (typeof code === "string" && SPONSOR_CODES.has(code)) return true;
  if (status === 402 || status === 429) return true;
  const text = `${typeof message === "string" ? message : ""} ${typeof error === "string" ? error : ""}`;
  return /sponsor|unable to sign transaction|polic(y|ies)|quota|limit (reached|exceeded)|too many requests/i.test(text);
}

/**
 * Simulates, sends sponsored (falling back once to an unsponsored send when sponsorship is unavailable), and waits
 * for the receipt. Once a hash exists nothing here sends again: a lost receipt wait becomes a pending TxError.
 */
export async function sendContractTx(input: SendInput, deps: SenderDeps): Promise<Sent> {
  if (!deps.account) throw new TxError(NOT_LOGGED_IN_MESSAGE);
  if (!deps.embedded) throw new TxError(NO_EMBEDDED_MESSAGE);
  const call = { abi: input.abi as Abi, functionName: input.functionName, args: input.args };
  try {
    await deps.simulate({ ...call, account: deps.account, address: input.to, value: input.value });
  } catch (e) {
    const r = decodeRevert(e);
    throw new TxError(r.message, { name: r.name, args: r.args, inner: r.inner, cause: e });
  }

  const tx: UnsignedTx = { to: input.to, data: encodeFunctionData(call as never), value: input.value ?? 0n, chainId: 11155111 };
  let hash: Hex;
  try {
    ({ hash } = await deps.sendTransaction(tx, { sponsor: true }));
  } catch (sponsorErr) {
    if (!isSponsorUnavailable(sponsorErr)) throw sponsorErr;
    try {
      ({ hash } = await deps.sendTransaction(tx, { sponsor: false }));
    } catch {
      throw new TxError(NO_GAS_MESSAGE, { cause: sponsorErr });
    }
  }

  let receipt: TransactionReceipt;
  try {
    receipt = await deps.waitForReceipt(hash);
  } catch (e) {
    throw new TxError(`still confirming: ${hash}`, { hash, pending: true, cause: e });
  }
  if (receipt.status !== "success") throw new TxError(`transaction reverted: ${hash}`, { hash });
  return { hash, receipt };
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

type WaitFn = (blockNumber: bigint, opts: { intervalMs?: number; timeoutMs?: number }) => Promise<boolean>;

/**
 * Waits for the indexer to pass `blockNumber`, then invalidates caches. If the wait times out, keeps polling in the
 * background (every 5 s for up to 2 min) and invalidates once more when it catches up; `late` settles then.
 */
export async function syncAfterTx(
  blockNumber: bigint,
  deps: { wait?: WaitFn; invalidate: () => Promise<void> | void },
): Promise<{ indexed: boolean; late: Promise<boolean> }> {
  const wait: WaitFn = deps.wait ?? ((b, o) => waitForIndexer(b, o));
  const indexed = await wait(blockNumber, {}).catch(() => false);
  await deps.invalidate();
  if (indexed) return { indexed, late: Promise.resolve(true) };
  const late = wait(blockNumber, { intervalMs: 5000, timeoutMs: 120_000 })
    .catch(() => false)
    .then(async (caught) => {
      if (caught) await deps.invalidate();
      return caught;
    });
  return { indexed, late };
}

// ---------------------------------------------------------------------------------------------------------------------
// Step runner

/**
 * One transaction in a sequence.
 * `skip()` must reflect on-chain state reliably once an earlier run's transaction confirmed (read the allowance or
 * balance fresh, not a cached value): on a retry it decides whether a step that already went through is sent again.
 */
export type Step = { id: string; label: string; skip?: () => Promise<boolean>; run: () => Promise<Sent> };
/** `confirming`: broadcast, receipt not seen yet. The hash is kept and the step is never re-sent while it is unknown. */
export type StepStatus = "pending" | "running" | "skipped" | "done" | "failed" | "confirming";
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
 * (its skip(), when it has one, is re-evaluated and decides). A step left `confirming` is looked up by hash first
 * (`getReceipt`): success marks it done, a revert lets it run again, and an unknown receipt keeps it confirming and
 * stops the run, so a broadcast transaction is never sent twice.
 */
export async function runSteps(
  steps: Step[],
  deps: {
    onStatus: (results: StepResult[]) => void;
    previous?: StepResult[];
    getReceipt?: (hash: Hex) => Promise<TransactionReceipt | null>;
  },
): Promise<StepResult[]> {
  const results: StepResult[] = steps.map((s) => ({ id: s.id, status: "pending" }));
  const emit = () => deps.onStatus(results.map((r) => ({ ...r })));
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const prior = deps.previous?.find((r) => r.id === s.id);
    const before = prior?.status === "done" ? prior : undefined;
    if (prior?.status === "confirming" && prior.hash) {
      const hash = prior.hash;
      const receipt = deps.getReceipt ? await deps.getReceipt(hash).catch(() => null) : null;
      if (!receipt) {
        results[i] = { ...prior };
        emit();
        break;
      }
      if (receipt.status === "success") {
        results[i] = { id: s.id, status: "done", hash, blockNumber: receipt.blockNumber };
        emit();
        continue;
      }
      // Mined and reverted: nothing is in flight any more, so the step may run again.
    }
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
      if (e instanceof TxError && e.pending && e.hash) {
        results[i] = { id: s.id, status: "confirming", hash: e.hash, revert, cause: e };
        emit();
        break;
      }
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
