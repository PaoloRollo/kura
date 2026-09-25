import { describe, expect, it } from "vitest";
import config from "../ponder.config";
import deployments from "../generated/deployments.json";

describe("ponder.config", () => {
  it("indexes Sepolia with a public RPC fallback", () => {
    expect(config.chains.sepolia.id).toBe(11155111);
    const rpc = config.chains.sepolia.rpc as string[];
    expect(rpc.at(-1)).toBe("https://ethereum-sepolia-rpc.publicnode.com");
  });

  it("declares every Kura source", () => {
    expect(Object.keys(config.contracts).sort()).toEqual(
      ["Auction", "BidGateHook", "CardNames", "CardVault", "CollectorResolver", "EnsRegistry", "EnsResolver", "ShardToken"].sort(),
    );
    expect(config.blocks.AuctionTick.interval).toBe(5);
  });

  it("takes addresses and start block from deployments.json", () => {
    const startBlock = deployments.deployBlock - 1;
    expect(config.contracts.CardVault.address).toBe(deployments.cardVault);
    expect(config.contracts.BidGateHook.address).toBe(deployments.bidGateHook);
    expect(config.contracts.CardNames.address).toBe(deployments.cardNames);
    expect(config.contracts.EnsRegistry.address).toBe(deployments.ensRegistry);
    expect(config.contracts.EnsResolver.address).toBe(deployments.ensResolver);
    for (const c of Object.values(config.contracts)) expect(c.startBlock).toBe(startBlock);
    expect(config.blocks.AuctionTick.startBlock).toBe(startBlock);
  });

  it("wires factory children one level deep off CardVault and CardNames", () => {
    const shard = config.contracts.ShardToken.address as any;
    const auction = config.contracts.Auction.address as any;
    const resolver = config.contracts.CollectorResolver.address as any;
    expect(shard.address).toBe(deployments.cardVault);
    expect(shard.event.name).toBe("CardSharded");
    expect(shard.parameter).toBe("shardToken");
    expect(auction.address).toBe(deployments.cardVault);
    expect(auction.parameter).toBe("auction");
    expect(resolver.address).toBe(deployments.cardNames);
    expect(resolver.event.name).toBe("CollectorNamed");
    expect(resolver.parameter).toBe("resolver");
  });
});
