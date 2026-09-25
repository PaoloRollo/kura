import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { abi } from "@kura/shared";
import { addresses, publicClient } from "@/lib/chain";
import { checkHandle, type HandleReader } from "@/lib/handles";

const names = { abi: abi.cardNames, address: addresses.cardNames } as const;

const reader: HandleReader = {
  reserved: (labelHash) => publicClient.readContract({ ...names, functionName: "reserved", args: [labelHash] }),
  isAvailable: (label) => publicClient.readContract({ ...names, functionName: "isAvailable", args: [label] }),
  collectorLabel: (address) => publicClient.readContract({ ...names, functionName: "collectorLabels", args: [address] }),
};

/** `GET /api/ens/available?label=&address=`: whether `label.kura.eth` can be claimed (by `address`, when given). */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const label = params.get("label") ?? "";
  const address = params.get("address");
  try {
    const result = await checkHandle(label, reader, address && isAddress(address) ? (address as Address) : undefined);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("handle availability check failed", e);
    return NextResponse.json({ error: { code: "UNAVAILABLE", message: "Couldn't check the handle right now" } }, { status: 502 });
  }
}
