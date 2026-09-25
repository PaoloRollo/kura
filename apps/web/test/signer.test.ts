import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { APPRAISAL_TYPES, TICKET_TYPES, TicketKind, bidGateDomain, cardVaultDomain } from "@kura/shared";
import placeholder from "../../../packages/shared/deployments.placeholder.json";
import { deployments, resetDeploymentsForTests, setDeploymentsForTests } from "@/lib/deployments";
import { appraisalDigest, signAppraisal, signTicket, signerAddress, ticketDigest } from "@/lib/signer";

const KEY = ("0x" + "a1".repeat(32)) as `0x${string}`;
const t = { kind: TicketKind.HUMAN, subject: "0x1111111111111111111111111111111111111111" as const, nullifier: 7n, expiresAt: 1_800_000_000n };
const a = { cardId: 1n, shardToken: "0x2222222222222222222222222222222222222222" as const, usdcPerShard: 12_000_000n, expiresAt: 1_800_000_000n };

beforeAll(() => {
  process.env.SIGNER_PRIVATE_KEY = KEY;
});

afterEach(() => resetDeploymentsForTests());

/** The real deployment, with the signer swapped for the test key's address. */
function useTestSigner() {
  setDeploymentsForTests({ ...deployments(), signer: privateKeyToAccount(KEY).address });
}

describe("signer", () => {
  it("signs tickets against the hook domain and appraisals against the vault domain", async () => {
    useTestSigner();
    const d = deployments();
    const sig = await signTicket(t, "bidgate");
    expect(await verifyTypedData({ address: signerAddress(), domain: bidGateDomain(d.bidGateHook), types: TICKET_TYPES, primaryType: "Ticket", message: t, signature: sig })).toBe(true);
    expect(await verifyTypedData({ address: signerAddress(), domain: cardVaultDomain(d.cardVault), types: TICKET_TYPES, primaryType: "Ticket", message: t, signature: sig })).toBe(false);

    const asig = await signAppraisal(a);
    expect(await verifyTypedData({ address: signerAddress(), domain: cardVaultDomain(d.cardVault), types: APPRAISAL_TYPES, primaryType: "Appraisal", message: a, signature: asig })).toBe(true);
    expect(ticketDigest(t, "bidgate")).not.toBe(ticketDigest(t, "vault"));
    expect(appraisalDigest(a)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses to sign against placeholder deployments", async () => {
    setDeploymentsForTests({ ...(placeholder as ReturnType<typeof deployments>), signer: privateKeyToAccount(KEY).address });
    await expect(signTicket(t, "bidgate")).rejects.toMatchObject({ code: "CONFIG", status: 500 });
    await expect(signAppraisal(a)).rejects.toMatchObject({ code: "CONFIG", status: 500 });
  });

  it("refuses to sign when the key is not the deployed signer", async () => {
    // The committed deployment names the real signer, which the test key is not.
    expect(deployments().signer.toLowerCase()).not.toBe(privateKeyToAccount(KEY).address.toLowerCase());
    await expect(signTicket(t, "vault")).rejects.toMatchObject({ code: "CONFIG", status: 500 });
    await expect(signAppraisal(a)).rejects.toMatchObject({ code: "CONFIG", status: 500 });
  });
});
