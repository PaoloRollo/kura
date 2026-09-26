// Type bridge. The indexer schema is typed against ponder's drizzle-orm copy and @ponder/client against another (pnpm
// splits drizzle-orm on its pglite peer), so tables and columns are nominally incompatible at the type level only; at
// runtime they are the same objects. `t()` hands a table or column to the query builder, `Row` types the result.
export type Row<T> = T extends { $inferSelect: infer R } ? R : never;
export const t = <T>(x: T): never => x as never;
