import "server-only";
import { abi } from "@kura/shared";
import { addresses, publicClient } from "@/lib/chain";
import { siteUriReader } from "@/lib/site-uri";

/** The vault's siteURI, read on chain and cached for ten minutes (server side). */
export const vaultSiteUri = siteUriReader(() => publicClient.readContract({ address: addresses.cardVault, abi: abi.cardVault, functionName: "siteURI" }));
