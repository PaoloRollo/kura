"use client";

import { useCallback } from "react";
import { useSendTransaction, useWallets } from "@privy-io/react-auth";
import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { publicClient } from "@/lib/chain";
import { TxError, decodeRevert, type Sent } from "@/lib/tx-core";

export * from "@/lib/tx-core";

export type SendInput = { to: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint };

/**
 * Sends contract calls from the embedded wallet with Privy gas sponsorship.
 * Each call is simulated first so a revert surfaces as a decoded TxError before anything is signed.
 * Under sponsorship `tx.from` can be a relayer: identify users from event args or indexer rows, never from `from`.
 */
export function useSendTx() {
  const { sendTransaction } = useSendTransaction();
  const { wallets } = useWallets();
  const embedded = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
  const address = embedded?.address as Address | undefined;

  const send = useCallback(
    async (input: SendInput): Promise<Sent> => {
      if (!address) throw new TxError("Log in to send transactions.");
      const call = { abi: input.abi as Abi, functionName: input.functionName, args: input.args as never };
      try {
        await publicClient.simulateContract({ ...call, account: address, address: input.to, value: input.value });
      } catch (e) {
        const r = decodeRevert(e);
        throw new TxError(r.message, { name: r.name, args: r.args, inner: r.inner, cause: e });
      }

      const tx = { to: input.to, data: encodeFunctionData(call), value: input.value ?? 0n, chainId: sepolia.id };
      const opts = { address, uiOptions: { showWalletUIs: false } };
      let hash: Hex;
      try {
        ({ hash } = await sendTransaction(tx, { ...opts, sponsor: true }));
      } catch (e) {
        // Sponsorship may be unavailable (billing, limits); retry unsponsored once so a funded wallet still works.
        if (e instanceof Error && /sponsor/i.test(e.message)) ({ hash } = await sendTransaction(tx, opts));
        else throw e;
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new TxError(`transaction reverted: ${hash}`, { hash });
      return { hash, receipt };
    },
    [sendTransaction, address],
  );

  return { send, address };
}
