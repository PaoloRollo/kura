import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
