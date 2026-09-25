import { z } from "zod";

const ServerSchema = z.object({
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  SIGNER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  WORLD_APP_ID: z.string().min(1),
  WORLD_RP_ID: z.string().min(1),
  WORLD_RP_SIGNING_KEY: z.string().min(1),
  WORLD_ENV: z.enum(["production", "staging", "sandbox"]),
  DATABASE_URL: z.string().min(1),
  ALCHEMY_HTTP_URL: z.string().url(),
  ALCHEMY_WS_URL: z.string().min(1),
  PONDER_URL: z.string().url(),
});

const PublicSchema = z.object({
  NEXT_PUBLIC_PRIVY_APP_ID: z.string().min(1),
  NEXT_PUBLIC_WORLD_APP_ID: z.string().min(1),
  NEXT_PUBLIC_WORLD_RP_ID: z.string().min(1),
  NEXT_PUBLIC_WORLD_ENV: z.enum(["production", "staging", "sandbox"]).default("staging"),
  NEXT_PUBLIC_WORLD_BID_ALLOW_LEGACY: z.string().optional(),
  NEXT_PUBLIC_CHAIN_ID: z.coerce.number().default(11155111),
  NEXT_PUBLIC_ALCHEMY_HTTP_URL: z.string().url(),
  NEXT_PUBLIC_PONDER_URL: z.string().url().default("http://localhost:42069"),
});

export type ServerEnv = z.infer<typeof ServerSchema>;
export type PublicEnv = z.infer<typeof PublicSchema>;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  return ServerSchema.parse(source);
}

let server: ServerEnv | null = null;
export function serverEnv(): ServerEnv {
  if (!server) server = parseServerEnv(process.env);
  return server;
}

// Next.js inlines NEXT_PUBLIC_* only when referenced literally, so list them explicitly.
export function publicEnv(): PublicEnv {
  return PublicSchema.parse({
    NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    NEXT_PUBLIC_WORLD_APP_ID: process.env.NEXT_PUBLIC_WORLD_APP_ID,
    NEXT_PUBLIC_WORLD_RP_ID: process.env.NEXT_PUBLIC_WORLD_RP_ID,
    NEXT_PUBLIC_WORLD_ENV: process.env.NEXT_PUBLIC_WORLD_ENV,
    NEXT_PUBLIC_WORLD_BID_ALLOW_LEGACY: process.env.NEXT_PUBLIC_WORLD_BID_ALLOW_LEGACY,
    NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID,
    NEXT_PUBLIC_ALCHEMY_HTTP_URL: process.env.NEXT_PUBLIC_ALCHEMY_HTTP_URL,
    NEXT_PUBLIC_PONDER_URL: process.env.NEXT_PUBLIC_PONDER_URL,
  });
}
