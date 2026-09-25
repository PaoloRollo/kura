"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http } from "wagmi";
import { sepolia } from "viem/chains";
import { publicEnv } from "@/env";

const env = publicEnv();
const queryClient = new QueryClient();
export const wagmiConfig = createConfig({
  chains: [sepolia],
  transports: { [sepolia.id]: http(env.NEXT_PUBLIC_ALCHEMY_HTTP_URL) },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={env.NEXT_PUBLIC_PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: sepolia,
        supportedChains: [sepolia],
        appearance: { theme: "dark", accentColor: "#E8552F" },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
