import { createClient } from "@ponder/client";
import * as schema from "../../../indexer/ponder.schema";

export { schema };

/** Browser client for the indexer's SQL endpoint. Query operators (eq, desc, ...) come from @ponder/client. */
export const ponderClient = createClient(`${process.env.NEXT_PUBLIC_PONDER_URL ?? "http://localhost:42069"}/sql`, { schema });

// Types usePonderQuery's `db` against the indexer schema.
declare module "@ponder/react" {
  interface Register {
    schema: typeof schema;
  }
}

export { t, type Row } from "@/lib/ponder-bridge";
