import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const source = resolve(root, "contracts/deployments/sepolia.json");
const fallback = resolve(root, "packages/shared/deployments.placeholder.json");
const targets = [resolve(root, "apps/web/src/generated/deployments.json"), resolve(root, "apps/indexer/generated/deployments.json")];

const from = existsSync(source) ? source : fallback;
for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(from, target);
  console.log(`synced ${from} -> ${target}`);
}
