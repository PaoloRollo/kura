import type { WebhookDelivery } from "@/lib/multibaas/webhook";

/** A MultiBaas event.emitted delivery of CardVault's AuctionSettled, shaped like https://docs.curvegrid.com/multibaas/webhooks. */
export function settledDelivery(
  vault: string,
  o: { card: number; graduated?: unknown; tx?: string; logIndex?: number | null; id?: string; removed?: boolean; name?: string },
): WebhookDelivery {
  const tx = o.tx ?? `0x${o.card.toString(16).padStart(64, "0")}`;
  // null: a rawFields without logIndex.
  const logIndex = o.logIndex === undefined ? 3 : o.logIndex;
  const input = (name: string, value: unknown, type: string) => ({ name, value, hashed: false, type });
  return {
    id: o.id ?? `delivery-${o.card}-${logIndex}`,
    event: "event.emitted",
    data: {
      triggeredAt: "2026-09-26T14:00:00+09:00",
      event: {
        name: o.name ?? "AuctionSettled",
        signature: "AuctionSettled(uint256,address,uint256,uint256,uint256,bool)",
        inputs: [
          input("id", String(o.card), "uint256"),
          input("shardToken", "0x5000000000000000000000000000000000000001", "address"),
          input("clearingPriceQ96", "792281625142643375935439503360", "uint256"),
          input("raisedUsdc", "5136000000", "uint256"),
          input("feeUsdc", "128400000", "uint256"),
          input("graduated", o.graduated ?? true, "bool"),
        ],
        rawFields: JSON.stringify({ address: vault.toLowerCase(), transactionHash: tx.toLowerCase(), ...(logIndex === null ? {} : { logIndex: `0x${logIndex.toString(16)}` }), removed: o.removed ?? false }),
        contract: { address: vault, addressLabel: "kura_vault", name: "CardVault", label: "kura_cardvault" },
        indexInLog: 0,
      },
      transaction: { from: "0x0000000000000000000000000000000000000abc", txHash: tx, txIndexInBlock: 0, blockHash: `0x${"cd".repeat(32)}`, blockNumber: 11_800_000 },
    },
  };
}
