"use client";

import { VaultView, type ReleasedCard } from "@/components/vault-view";
import { AIKO, CATALOG, REN, X7A3, usd } from "../catalog";
import { PreviewShell } from "../preview-shell";

const D = 86_400;

export function VaultPreview({ state, states, now }: { state: string; states: readonly string[]; now: number }) {
  const released: ReleasedCard[] = state === "released" ? [
    { id: 12n, name: CATALOG.solring.name, image: CATALOG.solring.image, to: AIKO, releasedAt: now - 600 },
    { id: 13n, name: CATALOG.walk.name, image: CATALOG.walk.image, to: AIKO, releasedAt: now - D },
    { id: 14n, name: CATALOG.force.name, image: CATALOG.force.image, to: REN, releasedAt: now - 2 * D },
    { id: 15n, name: CATALOG.recall.name, image: CATALOG.recall.image, to: X7A3, releasedAt: now - 4 * D },
  ] : [];
  return (
    <PreviewShell base="/design/vault" states={states} state={state} path="/app/vault">
      <VaultView parentName="kura.eth" feeBps={250} cardsHeld={23} feesEarned={usd(2410.5)} released={released} isLoading={state === "loading"} />
    </PreviewShell>
  );
}
