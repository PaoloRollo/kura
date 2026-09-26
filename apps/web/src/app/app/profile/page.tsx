"use client";

import { useWallets } from "@privy-io/react-auth";
import { ProfileView } from "@/components/profile-view";
import { IndexerLoading } from "@/components/sync-state";
import { useHandlesState } from "@/hooks/use-handles";
import { useKuraUser } from "@/hooks/use-kura-user";
import { useUsdcBalance, useWorldIdVerified } from "@/hooks/use-portfolio";
import { addresses } from "@/lib/chain";

/** Mobile · Profile (xog3h), the tab bar's Profile. */
export default function ProfilePage() {
  const { address, logout } = useKuraUser();
  const { wallets } = useWallets();
  const { handles } = useHandlesState();
  const balance = useUsdcBalance(address);
  const { verified } = useWorldIdVerified(address);
  if (!address) return <IndexerLoading title="Loading your profile" className="max-w-md" />;
  const w = wallets.find((x) => x.address.toLowerCase() === address.toLowerCase()) ?? wallets[0];
  const embedded = w?.walletClientType === "privy";
  const label = handles[address.toLowerCase()];
  return (
    <ProfileView
      me={address}
      handle={label ? `${label}.${addresses.ensParentLabel}.eth` : null}
      usdc={balance}
      verified={verified}
      wallet={embedded ? "Embedded · Privy" : w?.meta?.name ?? w?.walletClientType ?? "External wallet"}
      embedded={embedded}
      onLogout={logout}
    />
  );
}
