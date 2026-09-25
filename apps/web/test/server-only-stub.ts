// Empty stub for the `server-only` package under vitest.
// `server-only` throws when imported outside a React Server Component context,
// which vitest's node environment is not. Tests alias it to this no-op module
// (see vitest.config.ts) instead of importing the real package.
export {};
