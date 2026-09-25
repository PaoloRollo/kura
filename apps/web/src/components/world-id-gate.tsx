"use client";

import { useEffect, useState } from "react";
import { IDKitRequestWidget, passport, proofOfHuman, type RpContext } from "@worldcoin/idkit";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { publicEnv } from "@/env";
import { apiFetch, useKuraUser } from "@/hooks/use-kura-user";

export type IssuedTicket = { ticket: { kind: number; subject: `0x${string}`; nullifier: string; expiresAt: string }; signature: `0x${string}`; credential: string };

const ERRORS: Record<string, string> = {
  SIGNAL_MISMATCH: "That proof was made for a different wallet.",
  ALREADY_BOUND: "This World ID is already linked to another wallet.",
  WRONG_CREDENTIAL: "A stronger credential is required for this step.",
  WRONG_ENVIRONMENT: "Verification came from the wrong World environment.",
  WORLD_REJECTED: "World could not verify this proof.",
};

/**
 * Renders a button that opens the IDKit widget for `action`, binds the proof to `signal` (a wallet address),
 * has the backend verify it, and hands back the signed ticket. `subject` is only used for release, where the vendor
 * requests a ticket on behalf of the card holder.
 */
export function WorldIdGate(props: { action: "bid" | "release"; signal: `0x${string}`; subject?: `0x${string}`; label?: string; onTicket: (t: IssuedTicket) => void }) {
  const env = publicEnv();
  const { identityToken } = useKuraUser();
  const [open, setOpen] = useState(false);
  const [rp, setRp] = useState<RpContext | null>(null);

  useEffect(() => {
    if (!open || rp || !identityToken) return;
    apiFetch("/api/worldid/rp-context", { method: "POST", body: JSON.stringify({ action: props.action }), identityToken })
      .then((r) => r.json())
      .then((j) => setRp({ rp_id: j.rp_id, nonce: j.nonce, created_at: j.created_at, expires_at: j.expires_at, signature: j.signature }))
      .catch(() => toast.error("Could not start verification"));
  }, [open, rp, identityToken, props.action]);

  const preset = props.action === "release" ? passport({ signal: props.signal }) : proofOfHuman({ signal: props.signal });

  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={!identityToken}>
        {props.label ?? (props.action === "release" ? "Verify with Passport" : "Verify with World ID")}
      </Button>
      {rp && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={env.NEXT_PUBLIC_WORLD_APP_ID as `app_${string}`}
          action={props.action}
          rp_context={rp}
          allow_legacy_proofs={true}
          environment={env.NEXT_PUBLIC_WORLD_ENV}
          preset={preset}
          handleVerify={async (result) => {
            const res = await apiFetch("/api/worldid/verify", {
              method: "POST",
              body: JSON.stringify({ action: props.action, subject: props.subject, idkitResponse: result }),
              identityToken,
            });
            if (!res.ok) {
              const { error } = await res.json();
              throw new Error(ERRORS[error?.code] ?? error?.message ?? "Verification failed");
            }
            props.onTicket((await res.json()) as IssuedTicket);
          }}
          onSuccess={() => {
            toast.success("Verified");
          }}
          onError={(code) => {
            toast.error(code === "failed_by_host_app" ? "Verification was refused" : `Verification ${code}`);
          }}
        />
      )}
    </>
  );
}
