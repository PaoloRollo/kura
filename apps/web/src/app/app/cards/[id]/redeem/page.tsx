"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { CardLoading, CardNotFound, identityOf } from "@/components/card-page-view";
import { MobileNav } from "@/components/mobile-nav";
import { RedeemPage } from "@/components/redeem-panel";
import { PayoutClaimedView, RedeemedView, showVaultSuccess, useVaultSuccess } from "@/components/vault-success";
import { useCard } from "@/hooks/use-card";
import { useKuraUser } from "@/hooks/use-kura-user";

/** M3M7L5: redeem the physical card, as its own page (the card page's mobile Redeem button opens it). */
export default function RedeemRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const valid = /^\d+$/.test(id);
  const c = useCard(valid ? BigInt(id) : 0n);
  const { address } = useKuraUser();
  const router = useRouter();
  const success = useVaultSuccess(valid ? BigInt(id) : undefined);
  const cardHref = `/app/cards/${id}`;

  if (!valid) return <CardNotFound id={id} />;
  if (c.isLoading) return <CardLoading />;
  if (!c.card) return <CardNotFound id={id} />;
  const identity = identityOf(c);
  if (success) {
    return (
      <div className="flex flex-col gap-4">
        <MobileNav title={identity.name} fallback={cardHref} className="-mt-2" />
        {success.kind === "redeemed"
          ? <RedeemedView info={success} cardName={identity.name} onClose={() => { showVaultSuccess(null); router.push(cardHref); }} />
          : <PayoutClaimedView info={success} cardName={identity.name} onClose={() => showVaultSuccess(null)} />}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <MobileNav title="Redeem the physical card" fallback={cardHref} action={<span />} className="-mt-2" />
      <h2 className="text-[16px] font-semibold text-text-2 max-md:hidden">Redeem the physical card</h2>
      <RedeemPage c={c} me={address} identity={identity} />
    </div>
  );
}
