"use client";

import { useCallback } from "react";
import { useSendTransaction, useWallets } from "@privy-io/react-auth";
import type { Address, Hex, TransactionReceipt } from "viem";
import { publicClient } from "@/lib/chain";
import { sendContractTx, type SendInput, type Sent } from "@/lib/tx-core";

export * from "@/lib/tx-core";

/** The receipt for a broadcast transaction, or null while it is not mined (or the lookup fails). */
export async function getReceipt(hash: Hex): Promise<TransactionReceipt | null> {
  return publicClient.getTransactionReceipt({ hash }).catch(() => null);
}

/**
 * Sends contract calls from the embedded wallet with Privy gas sponsorship (see `sendContractTx`).
 * Under sponsorship `tx.from` can be a relayer: identify users from event args or indexer rows, never from `from`.
 */
export function useSendTx() {
  const { sendTransaction } = useSendTransaction();
  const { wallets } = useWallets();
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const hasEmbedded = !!embedded;
  const address = (embedded ?? wallets[0])?.address as Address | undefined;

  const send = useCallback(
    (input: SendInput): Promise<Sent> =>
      sendContractTx(input, {
        account: address,
        embedded: hasEmbedded,
        simulate: (req) => publicClient.simulateContract(req as never),
        sendTransaction: (tx, { sponsor }) =>
          sendTransaction(tx, { address, uiOptions: { showWalletUIs: false }, ...(sponsor ? { sponsor: true } : {}) }),
        waitForReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash }),
      }),
    [sendTransaction, address, hasEmbedded],
  );

  return { send, address };
}
