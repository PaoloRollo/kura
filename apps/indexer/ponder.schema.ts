import { onchainTable } from "ponder";

export const bootstrap = onchainTable("bootstrap", (t) => ({ id: t.text().primaryKey() }));
