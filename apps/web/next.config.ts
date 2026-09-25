import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The disk loader in lib/card-index.ts reads `join(dir, "manifest.json")` and friends, which output
  // tracing resolves to every such file in the app: the local index (~37 MB) and the test fixture would
  // ship inside the /api/scan/match function. The index is runtime data (CARD_INDEX_DIR, or
  // CARD_INDEX_URL on Vercel), never part of the function.
  outputFileTracingExcludes: { "/api/scan/match": ["./data/**/*", "./test/**/*"] },
  turbopack: {
    resolveAlias: {
      // transformers.js runs in the browser only (lib/card-embed.ts). Everywhere else (the SSR pass of
      // the station page) it resolves to a stub, so neither the library, onnxruntime-node nor a local
      // model cache is bundled or traced into the server output.
      "@huggingface/transformers": { browser: "@huggingface/transformers", default: "./src/lib/transformers-unavailable.ts" },
    },
  },
};

export default nextConfig;
