import { createConfig, factory } from "ponder";
import { getAbiItem } from "viem";
import { abi } from "@kura/shared";
import deployments from "./generated/deployments.json";

const rpc = [process.env.PONDER_RPC_URL_11155111, "https://ethereum-sepolia-rpc.publicnode.com"].filter((u): u is string => !!u);
const startBlock = Math.max(0, deployments.deployBlock - 1);

const cardSharded = getAbiItem({ abi: abi.cardVault, name: "CardSharded" });
const collectorNamed = getAbiItem({ abi: abi.cardNames, name: "CollectorNamed" });

export default createConfig({
  chains: {
    sepolia: { id: 11155111, rpc, ws: process.env.PONDER_WS_URL_11155111 },
  },
  contracts: {
    CardVault: { abi: abi.cardVault, chain: "sepolia", address: deployments.cardVault as `0x${string}`, startBlock },
    BidGateHook: { abi: abi.bidGateHook, chain: "sepolia", address: deployments.bidGateHook as `0x${string}`, startBlock },
    CardNames: { abi: abi.cardNames, chain: "sepolia", address: deployments.cardNames as `0x${string}`, startBlock },
    EnsRegistry: { abi: abi.ensRegistry, chain: "sepolia", address: deployments.ensRegistry as `0x${string}`, startBlock },
    EnsResolver: { abi: abi.ensResolver, chain: "sepolia", address: deployments.ensResolver as `0x${string}`, startBlock },
    ShardToken: {
      abi: abi.shardToken,
      chain: "sepolia",
      address: factory({ address: deployments.cardVault as `0x${string}`, event: cardSharded, parameter: "shardToken" }),
      startBlock,
    },
    Auction: {
      abi: abi.ccaAuction,
      chain: "sepolia",
      address: factory({ address: deployments.cardVault as `0x${string}`, event: cardSharded, parameter: "auction" }),
      startBlock,
    },
    CollectorResolver: {
      abi: abi.ensResolver,
      chain: "sepolia",
      address: factory({ address: deployments.cardNames as `0x${string}`, event: collectorNamed, parameter: "resolver" }),
      startBlock,
    },
  },
  blocks: {
    AuctionTick: { chain: "sepolia", interval: 5, startBlock },
  },
});
