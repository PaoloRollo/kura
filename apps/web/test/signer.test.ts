import { beforeAll, describe, expect, it } from "vitest";
import { verifyTypedData } from "viem";
import { APPRAISAL_TYPES, TICKET_TYPES, TicketKind, bidGateDomain, cardVaultDomain } from "@kura/shared";
import deployments from "@/generated/deployments.json";
import { appraisalDigest, signAppraisal, signTicket, signerAddress, ticketDigest } from "@/lib/signer";

beforeAll(() => {
  process.env.SIGNER_PRIVATE_KEY = "0x" + "a1".repeat(32);
});

describe("signer", () => {
  it("signs tickets against the hook domain and appraisals against the vault domain", async () => {
    const t = { kind: TicketKind.HUMAN, subject: "0x1111111111111111111111111111111111111111" as const, nullifier: 7n, expiresAt: 1_800_000_000n };
    const sig = await signTicket(t, "bidgate");
    expect(await verifyTypedData({ address: signerAddress(), domain: bidGateDomain(deployments.bidGateHook as `0x${string}`), types: TICKET_TYPES, primaryType: "Ticket", message: t, signature: sig })).toBe(true);
    expect(await verifyTypedData({ address: signerAddress(), domain: cardVaultDomain(deployments.cardVault as `0x${string}`), types: TICKET_TYPES, primaryType: "Ticket", message: t, signature: sig })).toBe(false);

    const a = { cardId: 1n, shardToken: "0x2222222222222222222222222222222222222222" as const, usdcPerShard: 12_000_000n, expiresAt: 1_800_000_000n };
    const asig = await signAppraisal(a);
    expect(await verifyTypedData({ address: signerAddress(), domain: cardVaultDomain(deployments.cardVault as `0x${string}`), types: APPRAISAL_TYPES, primaryType: "Appraisal", message: a, signature: asig })).toBe(true);
    expect(ticketDigest(t, "bidgate")).not.toBe(ticketDigest(t, "vault"));
    expect(appraisalDigest(a)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
