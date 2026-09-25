"use client";

import { useCallback } from "react";
import { useSendTransaction, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { createWalletClient, custom, type Address, type Hex, type TransactionReceipt } from "viem";
import { sepolia } from "viem/chains";
import { publicClient } from "@/lib/chain";
import { useKuraUser } from "@/hooks/use-kura-user";
import { sendContractTx, type EmbeddedWallet, type ExternalWallet, type SendInput, type Sent } from "@/lib/tx-core";

export * from "@/lib/tx-core";

/** The receipt for a broadcast transaction, or null while it is not mined (or the lookup fails). */
export async function getReceipt(hash: Hex): Promise<TransactionReceipt | null> {
  return publicClient.getTransactionReceipt({ hash }).catch(() => null);
}

const isEmbedded = (w: ConnectedWallet) => w.walletClientType === "privy" || w.walletClientType === "privy-v2";

function externalWallet(w: ConnectedWallet): ExternalWallet {
  return {
    kind: "external",
    getChainId: async () => Number(await (await w.getEthereumProvider()).request({ method: "eth_chainId" })),
    switchChain: (id) => w.switchChain(id),
    sendTransaction: async (tx) => {
      const account = w.address as Address;
      // Do every read (nonce, gas, fees) through our own RPC, so the wallet's RPC is only used to sign and broadcast.
      // Wallets like Rabby default to a public Sepolia RPC that may refuse reads (e.g. drpc's free tier).
      const [nonce, gas, fees] = await Promise.all([
        publicClient.getTransactionCount({ address: account, blockTag: "pending" }),
        publicClient.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value }),
        publicClient.estimateFeesPerGas(),
      ]);
      const client = createWalletClient({ account, chain: sepolia, transport: custom(await w.getEthereumProvider()) });
      const hash = await client.sendTransaction({
        to: tx.to, data: tx.data, value: tx.value, nonce, gas: (gas * 12n) / 10n,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      return { hash };
    },
  };
}

/**
 * Sends contract calls as the user's identity wallet (`useKuraUser().address`, the server's rule: embedded first,
 * otherwise the first linked wallet). An embedded wallet sends through Privy with gas sponsorship; an external one
 * (the vendor's EOA) sends unsponsored through its own provider. See `sendContractTx`.
 * Under sponsorship `tx.from` can be a relayer: identify users from event args or indexer rows, never from `from`.
 */
export function useSendTx() {
  const { sendTransaction } = useSendTransaction();
  const { wallets } = useWallets();
  const { address } = useKuraUser();
  const connected = address ? wallets.find((w) => w.address.toLowerCase() === address.toLowerCase()) : undefined;

  const send = useCallback(
    (input: SendInput): Promise<Sent> => {
      let wallet: EmbeddedWallet | ExternalWallet | undefined;
      if (connected && isEmbedded(connected)) {
        wallet = {
          kind: "embedded",
          sendTransaction: (tx, { sponsor }) =>
            sendTransaction(tx, { address: connected.address, uiOptions: { showWalletUIs: false }, ...(sponsor ? { sponsor: true } : {}) }),
        };
      } else if (connected) {
        wallet = externalWallet(connected);
      }
      return sendContractTx(input, {
        account: address ?? undefined,
        wallet,
        simulate: (req) => publicClient.simulateContract(req as never),
        waitForReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash }),
      });
    },
    [sendTransaction, address, connected],
  );

  return { send, address: address ?? undefined };
}
