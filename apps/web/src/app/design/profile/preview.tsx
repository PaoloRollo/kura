"use client";

import { ProfileView } from "@/components/profile-view";
import { PAOLO, usd } from "../catalog";
import { PreviewShell } from "../preview-shell";

export function ProfilePreview({ state, states }: { state: string; states: readonly string[] }) {
  const external = state === "external";
  return (
    <PreviewShell base="/design/profile" states={states} state={state} path="/app/profile">
      <ProfileView
        me={PAOLO}
        handle={state === "no-handle" ? null : "paolo.kura.eth"}
        usdc={state === "no-usdc" ? 0n : usd(248.5)}
        verified={state !== "no-handle"}
        wallet={external ? "MetaMask" : "Embedded · Privy"}
        embedded={!external}
        onLogout={() => {}}
      />
    </PreviewShell>
  );
}
