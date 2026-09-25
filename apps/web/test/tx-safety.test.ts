import { describe, expect, it, vi } from "vitest";
import { encodeErrorResult, parseAbi, type Hex, type TransactionReceipt } from "viem";
import {
  EXTERNAL_GAS_MESSAGE,
  NOT_CONNECTED_MESSAGE,
  NO_GAS_MESSAGE,
  WRONG_CHAIN_MESSAGE,
  identityAddress,
  TxError,
  decodeRevert,
  runSteps,
  sendContractTx,
  syncAfterTx,
  type SenderDeps,
  type Step,
  type StepResult,
} from "@/lib/tx-core";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const TO = "0x2222222222222222222222222222222222222222" as const;
const H1 = ("0x" + "a1".repeat(32)) as Hex;
const H2 = ("0x" + "b2".repeat(32)) as Hex;
const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const input = { to: TO, abi: erc20, functionName: "approve", args: [TO, 1n] };
const receipt = (status: "success" | "reverted", blockNumber = 7n) => ({ status, blockNumber }) as TransactionReceipt;

type EmbeddedSend = (tx: unknown, o: { sponsor: boolean }) => Promise<{ hash: Hex }>;

function deps(over: Partial<SenderDeps> & { sendTransaction?: EmbeddedSend } = {}): SenderDeps & { sendTransaction: EmbeddedSend } {
  const { sendTransaction = vi.fn(async () => ({ hash: H1 })), ...rest } = over;
  return {
    account: ACCOUNT,
    wallet: { kind: "embedded", sendTransaction },
    simulate: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => receipt("success")),
    sendTransaction,
    ...rest,
  };
}

describe("sendContractTx", () => {
  it("sends sponsored and returns the mined receipt", async () => {
    const d = deps();
    const sent = await sendContractTx(input, d);
    expect(sent.hash).toBe(H1);
    expect(d.sendTransaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.sendTransaction).mock.calls[0][1]).toEqual({ sponsor: true });
  });

  it("keeps the hash as a pending TxError when the receipt wait gives up, and never re-sends", async () => {
    const d = deps({ waitForReceipt: vi.fn(async () => { throw new Error("Timed out while waiting for transaction"); }) });
    const err = await sendContractTx(input, d).catch((e) => e);
    expect(err).toBeInstanceOf(TxError);
    expect(err).toMatchObject({ hash: H1, pending: true });
    expect(d.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("throws a TxError with the hash, not pending, when the transaction reverts", async () => {
    const err = await sendContractTx(input, deps({ waitForReceipt: vi.fn(async () => receipt("reverted")) })).catch((e) => e);
    expect(err).toMatchObject({ hash: H1, pending: false });
  });

  it.each([
    ["a sponsorship error", new Error("Sponsoring transactions is only supported for wallets on the TEE stack")],
    ["Privy's unable to sign", new Error("Unable to sign transaction")],
    ["a policy violation", Object.assign(new Error("Transaction violates policy"), { code: "policy_violation", status: 403 })],
    ["a quota error", Object.assign(new Error("Gas sponsorship quota exceeded"), { status: 429 })],
    ["too many requests", Object.assign(new Error("nope"), { code: "too_many_requests" })],
  ])("falls back to an unsponsored send after %s", async (_, sponsorErr) => {
    const send = vi.fn(async (_tx: unknown, o: { sponsor: boolean }) => {
      if (o.sponsor) throw sponsorErr;
      return { hash: H2 };
    });
    const sent = await sendContractTx(input, deps({ sendTransaction: send }));
    expect(sent.hash).toBe(H2);
    expect(send.mock.calls.map((c) => c[1])).toEqual([{ sponsor: true }, { sponsor: false }]);
  });

  it("does not fall back on unrelated errors", async () => {
    const send = vi.fn(async () => { throw new Error("User rejected the request"); });
    await expect(sendContractTx(input, deps({ sendTransaction: send }))).rejects.toThrow("User rejected");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("says plainly when neither sponsorship nor the wallet can pay for gas", async () => {
    const sponsorErr = new Error("Unable to sign transaction");
    const send = vi.fn(async (_tx: unknown, o: { sponsor: boolean }) => {
      throw o.sponsor ? sponsorErr : new Error("insufficient funds for gas * price + value");
    });
    const err = await sendContractTx(input, deps({ sendTransaction: send })).catch((e) => e);
    expect(err).toBeInstanceOf(TxError);
    expect(err.message).toBe(NO_GAS_MESSAGE);
    expect(err.cause).toBe(sponsorErr);
    expect(err.hash).toBeUndefined();
  });

  it("refuses clearly when the identity's wallet is not connected", async () => {
    await expect(sendContractTx(input, deps({ wallet: undefined }))).rejects.toThrow(NOT_CONNECTED_MESSAGE);
  });
});

function external(over: { chainId?: number; switchChain?: (id: number) => Promise<void>; send?: (tx: unknown) => Promise<{ hash: Hex }> } = {}) {
  let chain = over.chainId ?? 11155111;
  const w = {
    kind: "external" as const,
    getChainId: vi.fn(async () => chain),
    switchChain: vi.fn(over.switchChain ?? (async (id: number) => { chain = id; })),
    sendTransaction: vi.fn(over.send ?? (async () => ({ hash: H2 }))),
  };
  return w;
}

describe("sendContractTx from an external wallet", () => {
  it("sends unsponsored through the wallet's own provider, after simulating", async () => {
    const w = external();
    const d = deps({ wallet: w });
    const sent = await sendContractTx(input, d);
    expect(sent.hash).toBe(H2);
    expect(d.simulate).toHaveBeenCalledTimes(1);
    expect(w.sendTransaction).toHaveBeenCalledTimes(1);
    expect(w.sendTransaction.mock.calls[0]).toHaveLength(1); // no sponsor option on this path
    expect(w.switchChain).not.toHaveBeenCalled();
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });

  it("switches to Sepolia first when the wallet is on another chain", async () => {
    const w = external({ chainId: 1 });
    await sendContractTx(input, deps({ wallet: w }));
    expect(w.switchChain).toHaveBeenCalledWith(11155111);
    expect(w.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("says so plainly when the switch is declined", async () => {
    const w = external({ chainId: 1, switchChain: async () => { throw new Error("User rejected the request."); } });
    await expect(sendContractTx(input, deps({ wallet: w }))).rejects.toThrow(WRONG_CHAIN_MESSAGE);
    expect(w.sendTransaction).not.toHaveBeenCalled();
  });

  it("asks for a little Sepolia ETH when the wallet can't pay for gas", async () => {
    const gasErr = new Error("insufficient funds for gas * price + value");
    const w = external({ send: async () => { throw gasErr; } });
    const err = await sendContractTx(input, deps({ wallet: w })).catch((e) => e);
    expect(err).toBeInstanceOf(TxError);
    expect(err.message).toBe(EXTERNAL_GAS_MESSAGE);
    expect(err.cause).toBe(gasErr);
  });

  it("keeps the pending-hash safety", async () => {
    const w = external();
    const err = await sendContractTx(input, deps({ wallet: w, waitForReceipt: async () => { throw new Error("timeout"); } })).catch((e) => e);
    expect(err).toMatchObject({ hash: H2, pending: true });
    expect(w.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("identityAddress", () => {
  const w = (address: string, walletClientType?: string, chainType = "ethereum") => ({ type: "wallet", address, chainType, walletClientType });
  it("matches the server: the embedded wallet first, otherwise the first linked ethereum wallet", () => {
    expect(identityAddress([{ type: "email" }, w("0xAAA", "metamask"), w("0xBBB", "privy")])).toBe("0xBBB");
    expect(identityAddress([w("0xSOL", "phantom", "solana"), w("0xAAA", "metamask"), w("0xCCC", "coinbase_wallet")])).toBe("0xAAA");
    expect(identityAddress([{ type: "email" }])).toBeNull();
  });
});

const ok = (hash: Hex) => async () => ({ hash, receipt: receipt("success", 9n) });

describe("runSteps with a transaction still confirming", () => {
  it("marks the step confirming with its hash and stops", async () => {
    const later = vi.fn(ok(H2));
    const results = await runSteps(
      [
        { id: "a", label: "A", run: async () => { throw new TxError("still confirming", { hash: H1, pending: true }); } },
        { id: "b", label: "B", run: later },
      ],
      { onStatus: vi.fn() },
    );
    expect(results.map((r) => r.status)).toEqual(["confirming", "pending"]);
    expect(results[0].hash).toBe(H1);
    expect(later).not.toHaveBeenCalled();
  });

  const prev: StepResult[] = [{ id: "a", status: "confirming", hash: H1 }, { id: "b", status: "pending" }];

  it("on retry marks it done when the receipt shows success, without re-sending", async () => {
    const runA = vi.fn(ok(H2));
    const results = await runSteps(
      [{ id: "a", label: "A", run: runA }, { id: "b", label: "B", run: ok(H2) }],
      { onStatus: vi.fn(), previous: prev, getReceipt: async () => receipt("success", 11n) },
    );
    expect(runA).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ status: "done", hash: H1, blockNumber: 11n });
    expect(results[1].status).toBe("done");
  });

  it("on retry re-runs it when the receipt shows a revert", async () => {
    const runA = vi.fn(ok(H2));
    const results = await runSteps([{ id: "a", label: "A", run: runA }], {
      onStatus: vi.fn(), previous: prev, getReceipt: async () => receipt("reverted"),
    });
    expect(runA).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ status: "done", hash: H2 });
  });

  it("on retry keeps waiting while the receipt is still unknown", async () => {
    const runA = vi.fn(ok(H2));
    const runB = vi.fn(ok(H2));
    const results = await runSteps([{ id: "a", label: "A", run: runA }, { id: "b", label: "B", run: runB }], {
      onStatus: vi.fn(), previous: prev, getReceipt: async () => null,
    });
    expect(runA).not.toHaveBeenCalled();
    expect(runB).not.toHaveBeenCalled();
    expect(results.map((r) => r.status)).toEqual(["confirming", "pending"]);
    expect(results[0].hash).toBe(H1);
  });
});

describe("runSteps retry with previous results", () => {
  it("keeps done steps and re-evaluates skip()", async () => {
    const previous: StepResult[] = [
      { id: "noskip", status: "done", hash: H1, blockNumber: 1n },
      { id: "skipTrue", status: "done", hash: H1, blockNumber: 2n },
      { id: "skipFalse", status: "done", hash: H1, blockNumber: 3n },
      { id: "failed", status: "failed" },
    ];
    const runs: string[] = [];
    const step = (id: string, skip?: () => Promise<boolean>): Step => ({ id, label: id, skip, run: async () => { runs.push(id); return ok(H2)(); } });
    const skipTrue = vi.fn(async () => true);
    const skipFalse = vi.fn(async () => false);
    const results = await runSteps(
      [step("noskip"), step("skipTrue", skipTrue), step("skipFalse", skipFalse), step("failed")],
      { onStatus: vi.fn(), previous },
    );
    expect(skipTrue).toHaveBeenCalled();
    expect(skipFalse).toHaveBeenCalled();
    expect(runs).toEqual(["skipFalse", "failed"]);
    expect(results.map((r) => [r.status, r.hash])).toEqual([["done", H1], ["done", H1], ["done", H2], ["done", H2]]);
  });
});

describe("decodeRevert", () => {
  it("decodes Permit2 errors", () => {
    const permit2 = parseAbi(["error AllowanceExpired(uint256 deadline)", "error InsufficientAllowance(uint256 amount)", "error InvalidNonce()"]);
    const r = decodeRevert({ data: encodeErrorResult({ abi: permit2, errorName: "AllowanceExpired", args: [123n] }) });
    expect(r).toMatchObject({ name: "AllowanceExpired", args: [123n] });
    expect(decodeRevert({ data: encodeErrorResult({ abi: permit2, errorName: "InsufficientAllowance", args: [5n] }) }).name).toBe("InsufficientAllowance");
    expect(decodeRevert({ data: encodeErrorResult({ abi: permit2, errorName: "InvalidNonce" }) }).name).toBe("InvalidNonce");
  });

  it("carries the hash of a mined TxError", () => {
    expect(decodeRevert(new TxError("transaction reverted", { hash: H1 }))).toMatchObject({ name: null, hash: H1 });
  });
});

describe("syncAfterTx", () => {
  it("invalidates once when the indexer catches up in time", async () => {
    const wait = vi.fn(async () => true);
    const invalidate = vi.fn(async () => {});
    const r = await syncAfterTx(5n, { wait, invalidate });
    expect(r.indexed).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("after a timeout keeps polling every 5 s for 2 min and invalidates again when it catches up", async () => {
    const wait = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const invalidate = vi.fn(async () => {});
    const r = await syncAfterTx(5n, { wait, invalidate });
    expect(r.indexed).toBe(false);
    expect(await r.late).toBe(true);
    expect(wait.mock.calls[1]).toEqual([5n, { intervalMs: 5000, timeoutMs: 120_000 }]);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
