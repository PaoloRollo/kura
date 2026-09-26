import "server-only";
import { createClient } from "@ponder/client";
import * as schema from "../../../indexer/ponder.schema";
import { serverIndexerUrl } from "@/lib/indexer-config";

let client: ReturnType<typeof createClient<typeof schema>> | null = null;

/** Server client for route handlers, against PONDER_URL (throws in production without it). Query operators (eq, desc, ...) come from @ponder/client. */
export function ponderServer() {
  if (!client) client = createClient(`${serverIndexerUrl()}/sql`, { schema });
  return client;
}

export { schema };
