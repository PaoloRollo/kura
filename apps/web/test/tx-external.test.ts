import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { sendExternalTx, type ExternalSendReader, type ExternalSendRequest } from "@/lib/tx-core";

const account = "0x1111111111111111111111111111111111111111" as const;
const tx = { to: "0x2222222222222222222222222222222222222222" as const, data: "0xabcdef" as const, value: 0n, chainId: 11155111 };

function stubReader() {
  return {
    getTransactionCount: vi.fn(async () => 7),
    estimateGas: vi.fn(async () => 100_000n),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_500_000_000n })),
  } satisfies ExternalSendReader;
}

describe("sendExternalTx", () => {
  it("reads nonce, gas and fees through our RPC and sends the exact EIP-1559 request", async () => {
    const reader = stubReader();
    const send = vi.fn<(r: ExternalSendRequest) => Promise<Hex>>(async () => "0xfeed");
    const out = await sendExternalTx(reader, send, account, tx);

    expect(out).toEqual({ hash: "0xfeed" });
    expect(reader.getTransactionCount).toHaveBeenCalledWith({ address: account, blockTag: "pending" });
    expect(reader.estimateGas).toHaveBeenCalledWith({ account, to: tx.to, data: tx.data, value: 0n });
    expect(reader.estimateFeesPerGas).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const request = send.mock.calls[0]![0];
    expect(request).toStrictEqual({
      to: tx.to,
      data: tx.data,
      value: 0n,
      nonce: 7,
      gas: 120_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_500_000_000n,
    });
    expect(request).not.toHaveProperty("gasPrice");
  });

  it("rounds the 1.2x gas headroom down and never sends when a read fails", async () => {
    const reader = stubReader();
    reader.estimateGas.mockResolvedValueOnce(21_001n);
    const send = vi.fn<(r: ExternalSendRequest) => Promise<Hex>>(async () => "0x01");
    await sendExternalTx(reader, send, account, tx);
    expect(send.mock.calls[0]![0]).toMatchObject({ gas: 25_201n });

    reader.getTransactionCount.mockRejectedValueOnce(new Error("rpc down"));
    await expect(sendExternalTx(reader, send, account, tx)).rejects.toThrow("rpc down");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
