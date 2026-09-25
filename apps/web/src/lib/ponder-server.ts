import "server-only";
import { createClient } from "@ponder/client";
import * as schema from "../../../indexer/ponder.schema";

let client: ReturnType<typeof createClient<typeof schema>> | null = null;

/** Server client for route handlers, against PONDER_URL. Query operators (eq, desc, ...) come from @ponder/client. */
export function ponderServer() {
  if (!client) client = createClient(`${process.env.PONDER_URL ?? "http://localhost:42069"}/sql`, { schema });
  return client;
}

export { schema };
