import { describe, expect, it } from "vitest";
import { type AbiEvent, toEventSignature } from "viem";
import { abi } from "@kura/shared";

// The ENS handlers in src/names.ts subscribe to these exact events (ensdomains/contracts-v2 UserRegistry and
// PermissionedResolver); a regenerated abi.ts must keep them, indexed flags included (they change the topics).
const events = (items: readonly unknown[]) =>
  (items as AbiEvent[]).filter((i) => i.type === "event").map((e) =>
    `${toEventSignature(e)} ${e.inputs.map((p) => (p.indexed ? "i" : "-")).join("")}`);

describe("ENSv2 ABI events the indexer depends on", () => {
  it("registry", () => {
    expect(events(abi.ensRegistry)).toEqual(expect.arrayContaining([
      "LabelRegistered(uint256,bytes32,string,address,uint64,address) ii---i",
      "LabelUnregistered(uint256,address) ii",
      "ResolverUpdated(uint256,address,address) iii",
    ]));
  });
  it("resolver", () => {
    expect(events(abi.ensResolver)).toEqual(expect.arrayContaining([
      "Linked(uint256,bytes32,bytes) ii-",
      "TextUpdated(uint256,string,string,string) ii--",
      "AddressUpdated(uint256,uint256,bytes) i--",
    ]));
  });
  it("CardNames keeps its events", () => {
    const names = (abi.cardNames as readonly { type: string; name?: string }[]).filter((i) => i.type === "event").map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["CardNamed", "CardNameRevoked", "CollectorNamed"]));
  });
});
