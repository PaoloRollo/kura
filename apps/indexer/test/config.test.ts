import { describe, expect, it } from "vitest";
import config from "../ponder.config";
import deployments from "../generated/deployments.json";
import { abi } from "@kura/shared";
import { shardMarketSource } from "../src/lib/market-config";

describe("ponder.config", () => {
  it("indexes Sepolia with a public RPC fallback", () => {
    expect(config.chains.sepolia.id).toBe(11155111);
    const rpc = config.chains.sepolia.rpc as string[];
    expect(rpc.at(-1)).toBe("https://ethereum-sepolia-rpc.publicnode.com");
  });

  it("declares every Kura source, ShardMarket only when deployed", () => {
    const base = ["Auction", "BidGateHook", "CardNames", "CardVault", "CollectorResolver", "EnsRegistry", "EnsResolver", "ShardToken"];
    const hasMarket = deployments.shardMarket !== "0x0000000000000000000000000000000000000000";
    expect(Object.keys(config.contracts).sort()).toEqual((hasMarket ? [...base, "ShardMarket"] : base).sort());
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

  it("builds the ShardMarket source from deployments, or none for the zero address", () => {
    expect(shardMarketSource("0x0000000000000000000000000000000000000000", 5)).toEqual({});
    const s = shardMarketSource("0x00000000000000000000000000000000000000c0", 5);
    expect(s.ShardMarket).toMatchObject({ chain: "sepolia", address: "0x00000000000000000000000000000000000000c0", startBlock: 5 });
    expect(s.ShardMarket!.abi).toBe(abi.shardMarket);
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
