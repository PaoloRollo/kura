import { NextResponse } from "next/server";
import { isAddress, zeroAddress, type Address } from "viem";
import { abi } from "@kura/shared";
import { addresses, publicClient } from "@/lib/chain";
import { checkHandle, type HandleReader } from "@/lib/handles";

const names = { abi: abi.cardNames, address: addresses.cardNames } as const;

// One multicall: isAvailable(label), plus collectorLabels(address) when there is one.
const reader: HandleReader = {
  lookup: async (label, address) => {
    const [available, current] = await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...names, functionName: "isAvailable", args: [label] },
        { ...names, functionName: "collectorLabels", args: [address ?? zeroAddress] },
      ],
    });
    return { available, current: address ? current : "" };
  },
};

/** `GET /api/ens/available?label=&address=`: whether `label.kura.eth` can be claimed (by `address`, when given). */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const label = params.get("label") ?? "";
  const raw = params.get("address");
  const address = raw && isAddress(raw) ? (raw as Address) : undefined;
  try {
    const result = await checkHandle(label, reader, address);
    // A bare label check is the same for everyone and may be a few seconds stale; a wallet's own check is not cached.
    const cache = address ? "no-store" : "public, s-maxage=10";
    return NextResponse.json(result, { headers: { "cache-control": cache } });
  } catch (e) {
    console.error("handle availability check failed", e);
    return NextResponse.json({ error: { code: "UNAVAILABLE", message: "Couldn't check the handle right now" } }, { status: 502 });
  }
}
