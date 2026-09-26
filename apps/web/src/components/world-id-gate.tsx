"use client";

import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { IDKitRequestWidget, passport, proofOfHuman, type RpContext } from "@worldcoin/idkit";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { publicEnv } from "@/env";
import { WorldIdError, useWorldIdTicket, type IssuedTicket } from "@/hooks/use-world-id-ticket";

export type { IssuedTicket };

const ERRORS: Record<string, string> = {
  SIGNAL_MISMATCH: "That proof was made for a different wallet.",
  ALREADY_BOUND: "This World ID is already linked to another wallet.",
  WRONG_CREDENTIAL: "A stronger credential is required for this step.",
  WRONG_ENVIRONMENT: "Verification came from the wrong World environment.",
  WORLD_REJECTED: "World could not verify this proof.",
};

/** The human sentence for a World ID refusal code (the server's, or the widget's own). */
export function worldIdErrorMessage(code: string): string {
  if (ERRORS[code]) return ERRORS[code];
  if (code === "START_FAILED") return "Could not start verification.";
  if (code === "failed_by_host_app") return "Verification was refused.";
  return `Verification ${code}.`;
}

/**
 * Renders a button that opens the IDKit widget for `action`, binds the proof to `signal` (a wallet address),
 * has the backend verify it, and hands back the signed ticket. `subject` is only used for release, where the vendor
 * requests a ticket on behalf of the card holder.
 */
export function WorldIdGate(props: {
  action: "bid" | "release";
  signal: `0x${string}`;
  subject?: `0x${string}`;
  label?: string;
  onTicket: (t: IssuedTicket) => void;
  /**
   * A refused verification: the server's error code (ALREADY_BOUND...) and its `details` (`{ boundTo }`), or the
   * widget's own code. When set, the caller renders the refusal and the gate shows no toast.
   */
  onError?: (code: string, details?: Record<string, unknown>) => void;
  /** The widget closed (after a ticket, a refusal or a dismissal). */
  onClose?: () => void;
  /** Opens the widget on mount (a retry that needs a fresh ticket). */
  autoStart?: boolean;
  variant?: React.ComponentProps<typeof Button>["variant"];
  icon?: React.ReactNode;
  className?: string;
}) {
  const env = publicEnv();
  const world = useWorldIdTicket({ action: props.action, subject: props.subject });
  const ready = world.ready;
  const [open, setOpen] = useState(false);
  // The rp context is single-use (nonce) and short-lived, so a fresh one is fetched on every open and dropped on close.
  // It is tagged with the action it was signed for, so a change of `props.action` never reuses a stale context.
  const [rp, setRp] = useState<{ action: string; ctx: RpContext } | null>(null);
  const [starting, setStarting] = useState(false);
  const rpContext = rp?.action === props.action ? rp.ctx : null;

  const reported = useRef(false);
  // The widget can close while the server is still verifying: onClose then waits for that answer (ticket or refusal).
  const verifying = useRef(false);
  const closePending = useRef(false);

  async function start() {
    if (!ready) return;
    // A fresh attempt: an earlier refusal's "already reported" flag must not swallow this one's errors.
    reported.current = false;
    setStarting(true);
    setRp(null);
    try {
      const action = props.action;
      setRp({ action, ctx: await world.rpContext() });
      setOpen(true);
    } catch {
      if (props.onError) props.onError("START_FAILED");
      else toast.error("Could not start verification");
    } finally {
      setStarting(false);
    }
  }

  // Kick off once when asked to (once signed in); a ref keeps StrictMode from opening it twice.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!props.autoStart || autoStarted.current || !ready) return;
    autoStarted.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start once per mount
  }, [props.autoStart, ready]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setRp(null);
      if (verifying.current) closePending.current = true;
      else props.onClose?.();
    }
  }

  // Bids need v4 proofs (legacy nullifiers could bind a second wallet); the server enforces this, the flag only avoids a doomed prompt.
  const allowLegacy = props.action === "release" || env.NEXT_PUBLIC_WORLD_BID_ALLOW_LEGACY === "true";
  const preset = props.action === "release" ? passport({ signal: props.signal }) : proofOfHuman({ signal: props.signal });

  return (
    <>
      <Button variant={props.variant} className={props.className} onClick={start} disabled={!ready || starting}>
        {props.icon}
        {props.label ?? (props.action === "release" ? "Verify with Passport" : "Verify with World ID")}
      </Button>
      {rpContext && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={onOpenChange}
          app_id={env.NEXT_PUBLIC_WORLD_APP_ID as `app_${string}`}
          action={props.action}
          rp_context={rpContext}
          allow_legacy_proofs={allowLegacy}
          environment={env.NEXT_PUBLIC_WORLD_ENV}
          preset={preset}
          handleVerify={async (result) => {
            verifying.current = true;
            try {
              let issued: IssuedTicket;
              try {
                issued = await world.verify(result);
              } catch (e) {
                const code = e instanceof WorldIdError ? e.code : "";
                if (code && code !== "VERIFY_FAILED" && props.onError) {
                  reported.current = true;
                  props.onError(code, e instanceof WorldIdError ? e.details : undefined);
                }
                throw new Error(ERRORS[code] ?? (e instanceof Error ? e.message : "Verification failed"));
              }
              props.onTicket(issued);
            } finally {
              verifying.current = false;
              if (closePending.current) {
                closePending.current = false;
                props.onClose?.();
              }
            }
          }}
          onSuccess={() => {
            toast.success("Verified");
          }}
          onError={(code) => {
            // The server's refusal was already reported with its details; the widget's generic follow-up adds nothing.
            if (reported.current) return void (reported.current = false);
            if (props.onError) return props.onError(String(code));
            toast.error(code === "failed_by_host_app" ? "Verification was refused" : `Verification ${code}`);
          }}
        />
      )}
    </>
  );
}
