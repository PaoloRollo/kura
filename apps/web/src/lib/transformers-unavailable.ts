/**
 * Server-side stand-in for @huggingface/transformers (see next.config.ts): the card embedder runs in
 * the browser only, so server bundles resolve the library to this module and never trace its
 * onnxruntime-node binaries or any cached model weights into the deployment.
 */
throw new Error("@huggingface/transformers is browser-only in this app");
