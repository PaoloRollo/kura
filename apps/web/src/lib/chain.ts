import { createPublicClient, http, webSocket, type Address, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { DeploymentsSchema } from "@kura/shared";
import raw from "@/generated/deployments.json";

/** The deployed contract addresses (the appraiser is `addresses.signer`). */
export const addresses = DeploymentsSchema.parse(raw);

export const publicClient: PublicClient = createPublicClient({
  chain: sepolia,
  transport: http(process.env.NEXT_PUBLIC_ALCHEMY_HTTP_URL),
});

let ws: PublicClient | null = null;
/** A websocket client for subscriptions, created on first use. */
export function wsClient(): PublicClient {
  if (!ws) {
    ws = createPublicClient({
      chain: sepolia,
      transport: webSocket(process.env.NEXT_PUBLIC_ALCHEMY_WS_URL, { keepAlive: { interval: 10_000 } }),
    });
  }
  return ws;
}

export const explorerTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
export const explorerAddress = (a: Address | string) => `https://sepolia.etherscan.io/address/${a}`;
