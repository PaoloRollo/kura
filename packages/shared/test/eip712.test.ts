import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { APPRAISAL_TYPES, TICKET_TYPES, TicketKind, bidGateDomain, cardVaultDomain } from "../src/eip712";

const HOOK = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;

describe("eip712", () => {
  it("encodes the exact type strings the contracts use", () => {
    const ticketType = `Ticket(${TICKET_TYPES.Ticket.map((f) => `${f.type} ${f.name}`).join(",")})`;
    const appraisalType = `Appraisal(${APPRAISAL_TYPES.Appraisal.map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(ticketType).toBe("Ticket(uint8 kind,address subject,uint256 nullifier,uint256 expiresAt)");
    expect(appraisalType).toBe("Appraisal(uint256 cardId,address shardToken,uint256 usdcPerShard,uint256 expiresAt)");
    expect(keccak256(toBytes(ticketType))).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("uses the contract domain names and Sepolia", () => {
    expect(bidGateDomain(HOOK)).toEqual({ name: "Kura BidGate", version: "1", chainId: 11155111, verifyingContract: HOOK });
    expect(cardVaultDomain(VAULT)).toEqual({ name: "Kura CardVault", version: "1", chainId: 11155111, verifyingContract: VAULT });
  });

  it("produces a digest that a local account can sign and that changes with any field", async () => {
    const account = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000a11ce");
    const message = { kind: TicketKind.HUMAN, subject: account.address, nullifier: 42n, expiresAt: 1_700_000_000n };
    const d1 = hashTypedData({ domain: bidGateDomain(HOOK), types: TICKET_TYPES, primaryType: "Ticket", message });
    const d2 = hashTypedData({ domain: bidGateDomain(HOOK), types: TICKET_TYPES, primaryType: "Ticket", message: { ...message, nullifier: 43n } });
    const d3 = hashTypedData({ domain: bidGateDomain(VAULT), types: TICKET_TYPES, primaryType: "Ticket", message });
    expect(d1).not.toBe(d2);
    expect(d1).not.toBe(d3);
    const sig = await account.signTypedData({ domain: bidGateDomain(HOOK), types: TICKET_TYPES, primaryType: "Ticket", message });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });
});
