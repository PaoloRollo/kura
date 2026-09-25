"use client";

import { use, useRef } from "react";
import { CheckIcon, GavelIcon } from "lucide-react";
import type { Address, Hex, TransactionReceipt } from "viem";
import { abi } from "@kura/shared";
import { notify } from "@/components/kura";
import { CardLoading, CardNotFound } from "@/components/card-page-view";
import { ShardWizard, useUrlStepNav } from "@/components/shard-wizard";
import { TxStepper, describeTxError } from "@/components/tx-stepper";
import { useCard } from "@/hooks/use-card";
import { useKuraUser } from "@/hooks/use-kura-user";
import { useNow } from "@/hooks/use-now";
import { useVaultFeeBps } from "@/hooks/use-vault-fee";
import { addresses, publicClient } from "@/lib/chain";
import { dateTime } from "@/lib/card-view";
import { estimatedEnd, shardOutcome, shardRevertMessage, type ShardParams } from "@/lib/shard-math";
import { shardedFromLogs } from "@/lib/vendor";
import { useSendTx, type Revert, type Step } from "@/lib/tx";

const WHOLE = 1; // CardVault.State.Whole

/** Shard a whole card into an auction: `CardVault.shardAndAuction(id, params)`, sent by the card's owner. */
export default function ShardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const valid = /^\d+$/.test(id);
  const cardId = valid ? BigInt(id) : 0n;
  const c = useCard(cardId);
  const { address, ready, authenticated } = useKuraUser();
  const nav = useUrlStepNav();
  // The receipt `run` got back, so the success state reads the new auction without another round trip.
  const lastReceipt = useRef<TransactionReceipt | null>(null);
  const { send, walletKind } = useSendTx();
  const feeBps = useVaultFeeBps();
  const now = useNow(30_000);
  const cardHref = `/app/cards/${id}`;

  if (!valid) return <CardNotFound id={id} />;
  // Until the wallet is known, "not the owner" would be a guess: show loading instead of the gate.
  if (c.isLoading || !ready || (authenticated && !address)) return <CardLoading />;
  if (!c.card) return <CardNotFound id={id} />;

  function steps(p: ShardParams): Step[] {
    return [
      {
        id: "shard",
        label: `Shard into ${p.totalShards} and auction ${p.forSale}`,
        // A retry after the transaction landed must not send it again: the card is then escrowed with us as its sharder.
        skip: async () => {
          if (!address) return false;
          const card = await publicClient.readContract({ address: addresses.cardVault, abi: abi.cardVault, functionName: "cards", args: [cardId] });
          return card.state !== WHOLE && card.beneficialOwner.toLowerCase() === (address as Address).toLowerCase();
        },
        run: async () => {
          const sent = await send({ to: addresses.cardVault, abi: abi.cardVault, functionName: "shardAndAuction", args: [cardId, p] });
          lastReceipt.current = sent.receipt;
          return sent;
        },
      },
    ];
  }

  return (
    <ShardWizard
      c={c}
      me={address}
      feeBps={feeBps}
      now={now}
      cardHref={cardHref}
      nav={nav}
      renderSubmit={(p, disabled, onDone) => (
        <TxStepper
          steps={steps(p)}
          walletKind={walletKind}
          cta="Create shards and open auction"
          ctaIcon={<GavelIcon aria-hidden />}
          title="Opening your auction"
          failedTitle="The auction didn't open"
          disabled={disabled || !address}
          describeError={(e, r: Revert) => shardRevertMessage(r.inner?.name ?? r.name) ?? describeTxError(e, r)}
          retryable={(r) => !shardRevertMessage(r.inner?.name ?? r.name)}
          backLabel="Edit settings"
          successToast={false}
          onDone={(results) => {
            const at = Math.floor(Date.now() / 1000);
            const hash = results.find((r) => r.id === "shard")?.hash;
            const base = { params: p, hash, at };
            onDone(base);
            // The new auction, from this run's receipt (or the vault's record when a retry found the step done).
            void shardOutcome(hash, {
              getReceipt: async (h: Hex) =>
                lastReceipt.current?.transactionHash === h ? lastReceipt.current : publicClient.getTransactionReceipt({ hash: h }),
              readLogs: (logs) => shardedFromLogs(logs),
              readCard: async () => {
                const card = await publicClient.readContract({ address: addresses.cardVault, abi: abi.cardVault, functionName: "cards", args: [cardId] });
                return { shardToken: card.shardToken, auction: card.auction, endBlock: card.endBlock };
              },
              getBlockNumber: () => publicClient.getBlockNumber(),
            }).then((created) => onDone({ ...base, created }));
            notify({
              title: "Auction opened",
              body: `${p.forSale} of ${p.totalShards} shards for sale · ends ${dateTime(estimatedEnd(at, p.durationBlocks))}`,
              tone: "good",
              icon: <CheckIcon />,
            });
          }}
        />
      )}
    />
  );
}
