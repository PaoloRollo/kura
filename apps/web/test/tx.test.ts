import { describe, expect, it, vi } from "vitest";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeAbiParameters,
  encodeErrorResult,
} from "viem";
import { abi } from "@kura/shared";
import { TxError, boundedSet, decodeRevert, encodeHookData, isOwnTx, rememberOwnTx, runSteps, sendContractTx, waitForIndexer, type SenderDeps } from "@/lib/tx-core";
import { countdown, money, shards, shardsFixed, usdc } from "@/lib/format";

describe("encodeHookData", () => {
  it("round-trips the ticket tuple and signature", () => {
    const ticket = { kind: 1, subject: "0x1111111111111111111111111111111111111111" as const, nullifier: 42n, expiresAt: 1_800_000_000n };
    const sig = ("0x" + "ab".repeat(65)) as `0x${string}`;
    const data = encodeHookData(ticket, sig);
    const [t, s] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "kind", type: "uint8" }, { name: "subject", type: "address" }, { name: "nullifier", type: "uint256" }, { name: "expiresAt", type: "uint256" }] }, { type: "bytes" }],
      data,
    );
    expect(t).toEqual(ticket);
    expect(s).toBe(sig);
  });
});

describe("runSteps gas mode", () => {
  it("records how each step's gas was paid", async () => {
    const r = await runSteps(
      [{ id: "a", label: "A", run: async () => ({ hash: "0x1", receipt: { blockNumber: 1n } as never, gas: "self" }) }],
      { onStatus: () => {} },
    );
    expect(r[0]).toMatchObject({ status: "done", gas: "self" });
  });
});

describe("runSteps", () => {
  it("skips steps whose skip() is true and stops at the first failure", async () => {
    const calls: string[] = [];
    const ok = { hash: "0x1" as const, receipt: { blockNumber: 1n } as never };
    const results = await runSteps(
      [
        { id: "a", label: "A", skip: async () => true, run: async () => { calls.push("a"); return ok; } },
        { id: "b", label: "B", run: async () => { calls.push("b"); return ok; } },
        { id: "c", label: "C", run: async () => { calls.push("c"); throw new Error("boom"); } },
        { id: "d", label: "D", run: async () => { calls.push("d"); return ok; } },
      ],
      { onStatus: vi.fn() },
    );
    expect(calls).toEqual(["b", "c"]);
    expect(results.map((r) => r.status)).toEqual(["skipped", "done", "failed", "pending"]);
    expect(results[1].blockNumber).toBe(1n);
  });

  it("keeps the TxError on a failed step, with its hash", async () => {
    const err = new TxError("transaction reverted", { name: "Expired", hash: "0xdead" });
    const results = await runSteps([{ id: "a", label: "A", run: async () => { throw err; } }], { onStatus: vi.fn() });
    expect(results[0]).toMatchObject({ status: "failed", hash: "0xdead", revert: { name: "Expired" } });
    expect(results[0].cause).toBe(err);
  });
});

describe("decodeRevert", () => {
  const reverted = (data: `0x${string}`, functionName = "submitBid") =>
    new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: abi.ccaAuction, data, functionName }) as unknown as BaseError,
      { abi: abi.ccaAuction, functionName, args: [], contractAddress: "0x2222222222222222222222222222222222222222" },
    );

  it("decodes ValidationHookCallFailed(Expired()) into the inner hook reason", () => {
    const inner = encodeErrorResult({ abi: abi.bidGateHook, errorName: "Expired" });
    const data = encodeErrorResult({ abi: abi.ccaAuction, errorName: "ValidationHookCallFailed", args: [inner] });
    const r = decodeRevert(reverted(data));
    expect(r.name).toBe("ValidationHookCallFailed");
    expect(r.args).toEqual([inner]);
    expect(r.inner).toEqual({ name: "Expired", args: [] });
  });

  it("decodes nested errors from other contracts against the merged ABI", () => {
    const cardNamesError = abi.cardNames.find((i) => i.type === "error");
    if (!cardNamesError || cardNamesError.type !== "error") throw new Error("cardNames has no errors");
    const data = encodeErrorResult({ abi: [cardNamesError], errorName: cardNamesError.name, args: cardNamesError.inputs.map(() => 0n) as never });
    const r = decodeRevert(reverted(data, "mint"));
    expect(r.name).toBe(cardNamesError.name);
  });

  it("returns a null name for errors that are not reverts", () => {
    const r = decodeRevert(new Error("User rejected the request"));
    expect(r).toMatchObject({ name: null, args: [], message: "User rejected the request" });
    expect(decodeRevert(new TxError("x", { name: "Expired", hash: "0x1" })).name).toBe("Expired");
  });
});

describe("waitForIndexer", () => {
  it("resolves once the indexer passes the block and gives up at the timeout", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sepolia: { id: 11155111, block: { number: 100 + n++, timestamp: 0 } } })));
    expect(await waitForIndexer(102n, { url: "http://x", fetchImpl, intervalMs: 1, timeoutMs: 1000 })).toBe(true);
    const stuck = vi.fn(async () => new Response(JSON.stringify({ sepolia: { id: 11155111, block: null } })));
    expect(await waitForIndexer(5n, { url: "http://x", fetchImpl: stuck, intervalMs: 1, timeoutMs: 20 })).toBe(false);
  });
});

describe("format", () => {
  it("formats USDC and shards", () => {
    expect(usdc(12_500_000n)).toBe("12.50");
    expect(usdc(5n)).toBe("0.000005");
    expect(shards(25n * 10n ** 17n)).toBe("2.5");
    expect(shards(1n * 10n ** 18n)).toBe("1");
  });

  it("groups money and fixes shard decimals", () => {
    expect(money(1_712_000_000n, 0)).toBe("$1,712.00");
    expect(money(27_386_400_000n)).toBe("$27,386.40");
    expect(money(2_000_000_000n)).toBe("$2,000.00");
    expect(shardsFixed(13n * 10n ** 18n)).toBe("13.0");
    expect(shardsFixed(5n * 10n ** 17n)).toBe("0.5");
    expect(shardsFixed(12_345n * 10n ** 14n, 2)).toBe("1.23");
  });

  it("counts down in blocks of 12 seconds", () => {
    expect(countdown(21n)).toBe("04:12");
    expect(countdown(375n)).toBe("1:15:00");
    expect(countdown(300n + 6n * 7200n + 4n * 300n)).toBe("6d 5h");
    expect(countdown(0n)).toBe("00:00");
  });
});

describe("own transaction registry", () => {
  const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

  it("remembers hashes case-insensitively and keeps only the last 50", () => {
    expect(isOwnTx(null)).toBe(false);
    rememberOwnTx(hex(0xabc).toUpperCase().replace("0X", "0x"));
    expect(isOwnTx(hex(0xabc))).toBe(true);
    for (let i = 1; i <= 50; i++) rememberOwnTx(hex(0x10000 + i));
    expect(isOwnTx(hex(0xabc))).toBe(false);
    expect(isOwnTx(hex(0x10001))).toBe(true);
    expect(isOwnTx(hex(0x10000 + 50))).toBe(true);
  });

  it("boundedSet drops the oldest entry and refreshes a re-added one", () => {
    const s = boundedSet(2);
    s.add("a");
    s.add("b");
    s.add("a");
    s.add("c");
    expect([s.has("a"), s.has("b"), s.has("c"), s.size]).toEqual([true, false, true, 2]);
  });

  const input = { to: "0x2222222222222222222222222222222222222222" as const, abi: [], functionName: "approve", args: [] };
  const base = {
    account: "0x1111111111111111111111111111111111111111" as const,
    simulate: vi.fn(async () => undefined),
    waitForReceipt: vi.fn(async () => ({ status: "success", blockNumber: 1n }) as never),
  };
  const approve = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [], outputs: [] }] as const;

  it("sendContractTx remembers the hash from an embedded wallet", async () => {
    const d: SenderDeps = { ...base, wallet: { kind: "embedded", sendTransaction: async () => ({ hash: hex(0xe1) }) } };
    await sendContractTx({ ...input, abi: approve }, d);
    expect(isOwnTx(hex(0xe1))).toBe(true);
  });

  it("sendContractTx remembers the hash from an external wallet", async () => {
    const d: SenderDeps = {
      ...base,
      wallet: { kind: "external", getChainId: async () => 11155111, switchChain: async () => {}, sendTransaction: async () => ({ hash: hex(0xe2) }) },
    };
    await sendContractTx({ ...input, abi: approve }, d);
    expect(isOwnTx(hex(0xe2))).toBe(true);
  });
});
