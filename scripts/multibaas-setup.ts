// MultiBaas (Curvegrid) setup for Kura: idempotent, and a dry run unless --apply. It reads the deployment (GETs only)
// and prints what it would change:
//
//   pnpm multibaas:setup                                      plan: what --apply would change
//   pnpm multibaas:setup --webhook-base https://kuravault.xyz plan, including the webhook
//   pnpm multibaas:setup --apply --webhook-base https://…     apply it (you, not an agent)
//   pnpm multibaas:setup --verify                             GETs only: each saved query's rows and value types, the
//                                                             vault's indexing status, the webhook's recent deliveries
//   --show-secret                                             print the existing webhook's signing secret, for your env
//
// What --apply does: upload the CardVault ABI (packages/shared) as kura_cardvault 1.0, alias the deployed vault
// (contracts/deployments/sepolia.json) as kura_vault, link it with event sync from the deploy block, put the six saved
// Event Queries, and create or repoint the kura_web webhook. Reads MULTIBAAS_URL and MULTIBAAS_API_KEY from the shell
// or the repo's .env. Never writes a file; the webhook secret is printed for you to put in your env. Without --apply the
// client refuses to send anything but a GET.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toEventSignature, type AbiEvent } from "viem";
import {
  DeploymentsSchema,
  EVENT_QUERIES,
  MB,
  MB_MAX_PAGES,
  MB_PAGE,
  MB_QUERIES,
  cardVaultAbi,
  mbRequest,
  type MbConfig,
  type MbEventQuery,
  type MbFetch,
} from "@kura/shared";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEPOLIA = 11155111;

export type Args = { apply: boolean; verify: boolean; showSecret: boolean; webhookBase: string | null };

export function parseSetupArgs(argv: readonly string[]): Args {
  const apply = argv.includes("--apply");
  const verify = argv.includes("--verify");
  if (apply && verify) throw new Error("pick one of --apply and --verify");
  const known = new Set(["--apply", "--verify", "--show-secret", "--webhook-base", "--"]);
  for (const a of argv) if (a.startsWith("--") && !known.has(a)) throw new Error(`unknown flag ${a}`);
  let webhookBase: string | null = null;
  const i = argv.indexOf("--webhook-base");
  if (i >= 0) {
    let u: URL;
    try {
      u = new URL(argv[i + 1] ?? "");
    } catch {
      throw new Error("--webhook-base needs a URL, e.g. https://kuravault.xyz");
    }
    if (u.protocol !== "https:") throw new Error("--webhook-base must be https: deliveries are signed, not encrypted");
    webhookBase = u.origin;
  }
  return { apply, verify, showSecret: argv.includes("--show-secret"), webhookBase };
}

/**
 * MultiBaas stores bytecode in a NOT NULL column, so an ABI-only upload still sends `bin`. "0x" (empty bytecode)
 * matches its ByteCode pattern: the contract is linked to the already-deployed CardVault, never deployed from here.
 */
export const ABI_ONLY_BIN = "0x";

export type Desired = {
  contract: { label: string; contractName: string; version: string; rawAbi: string; bin: string };
  address: { alias: string; address: string; startingBlock: string };
  queries: Record<string, MbEventQuery>;
  webhook: { label: string; url: string; subscriptions: string[] } | null;
};

export function desiredState(deploymentsJson: unknown, webhookBase: string | null): Desired {
  const d = DeploymentsSchema.parse(deploymentsJson);
  if (d.chainId !== SEPOLIA) throw new Error(`the deployments file is for chain ${d.chainId}, expected Sepolia (${SEPOLIA})`);
  return {
    contract: { label: MB.contractLabel, contractName: MB.contractName, version: MB.contractVersion, rawAbi: JSON.stringify(cardVaultAbi), bin: ABI_ONLY_BIN },
    address: { alias: MB.addressAlias, address: d.cardVault, startingBlock: String(d.deployBlock) },
    queries: Object.fromEntries(Object.entries(MB_QUERIES).map(([k, label]) => [label, EVENT_QUERIES[k as keyof typeof MB_QUERIES]])),
    webhook: webhookBase ? { label: MB.webhookLabel, url: `${webhookBase}${MB.webhookPath}`, subscriptions: ["event.emitted"] } : null,
  };
}

export type Current = {
  contract: { rawAbi: string } | null;
  address: { address: string; contracts?: { label: string; version: string }[] } | null;
  queries: Record<string, MbEventQuery | null>;
  webhook: { id: number; url: string; subscriptions: string[]; secret?: string } | null;
};

export type Step = {
  kind: "contract" | "address" | "link" | "query" | "webhook-create" | "webhook-update";
  describe: string;
  method: "POST" | "PUT";
  path: string;
  body: unknown;
};

const eventSignatures = (rawAbi: string): string =>
  (JSON.parse(rawAbi) as { type: string }[]).filter((x) => x.type === "event").map((e) => toEventSignature(e as AbiEvent)).sort().join("|");

/** Sorted keys; nulls, empty strings, empty arrays and the default order ASC dropped: MultiBaas echoes defaults back. */
export function canonicalQuery(q: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x === null || x === undefined || x === "" || (Array.isArray(x) && x.length === 0)) continue;
        if (k === "order" && x === "ASC") continue;
        out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(q));
}

/** The steps that bring `have` to `want`, in dependency order, and the conflicts that block applying any of them. */
export function planSetup(want: Desired, have: Current): { steps: Step[]; conflicts: string[] } {
  const steps: Step[] = [];
  const conflicts: string[] = [];
  const c = want.contract;
  const a = want.address;
  if (!have.contract) {
    steps.push({ kind: "contract", describe: `upload the CardVault ABI as ${c.label} ${c.version}`, method: "POST", path: `/contracts/${c.label}`, body: c });
  } else if (eventSignatures(have.contract.rawAbi) !== eventSignatures(c.rawAbi)) {
    conflicts.push(`${c.label} ${c.version} in MultiBaas has other events than packages/shared's cardVaultAbi; delete it in MultiBaas or bump MB.contractVersion, then rerun`);
  }
  if (!have.address) {
    steps.push({ kind: "address", describe: `alias ${a.address} as ${a.alias}`, method: "POST", path: "/chains/ethereum/addresses", body: { alias: a.alias, address: a.address } });
  } else if (have.address.address.toLowerCase() !== a.address.toLowerCase()) {
    conflicts.push(`alias ${a.alias} points at ${have.address.address}, not the deployed CardVault ${a.address}`);
  }
  const linked = (have.address?.contracts ?? []).find((x) => x.label === c.label);
  if (!linked) {
    steps.push({
      kind: "link",
      describe: `link ${a.alias} to ${c.label} ${c.version}, syncing events from block ${a.startingBlock}`,
      method: "POST",
      path: `/chains/ethereum/addresses/${a.alias}/contracts`,
      body: { label: c.label, version: c.version, startingBlock: a.startingBlock },
    });
  } else if (linked.version !== c.version) {
    conflicts.push(`${a.alias} is linked to ${c.label} ${linked.version}, expected ${c.version}`);
  }
  for (const [label, q] of Object.entries(want.queries)) {
    const cur = have.queries[label] ?? null;
    if (!cur || canonicalQuery(cur) !== canonicalQuery(q)) {
      steps.push({ kind: "query", describe: `${cur ? "update" : "create"} Event Query ${label}`, method: "PUT", path: `/queries/${encodeURIComponent(label)}`, body: q });
    }
  }
  const w = want.webhook;
  if (w) {
    const h = have.webhook;
    if (!h) steps.push({ kind: "webhook-create", describe: `create webhook ${w.label} → ${w.url} (event.emitted)`, method: "POST", path: "/webhooks", body: w });
    else if (h.url !== w.url || [...h.subscriptions].sort().join() !== [...w.subscriptions].sort().join())
      steps.push({ kind: "webhook-update", describe: `point webhook ${w.label} (id ${h.id}) at ${w.url}`, method: "PUT", path: `/webhooks/${h.id}`, body: w });
  }
  return { steps, conflicts };
}

/** A fetch that refuses anything but a GET: every mode but --apply runs through it. */
export const readOnly =
  (f: MbFetch): MbFetch =>
  (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET") return Promise.reject(new Error(`refusing ${method} without --apply`));
    return f(url, init);
  };

type Hook = { id: number; label: string; url: string; subscriptions: string[]; secret?: string; failedCalls?: number; lastError?: string };
type Io = { cfg: MbConfig; fetch: MbFetch; log: (line: string) => void };

/** The kura_web webhook, looked for on every page of /webhooks (at most MB_PAGE per page). Throws rather than miss it. */
async function findHook(io: Io, timeoutMs?: number): Promise<Hook | null> {
  for (let page = 0; page < MB_MAX_PAGES; page++) {
    const hooks = (await mbRequest<Hook[]>(io.cfg, "GET", `/webhooks?offset=${page * MB_PAGE}&limit=${MB_PAGE}`, { fetch: io.fetch, timeoutMs })) ?? [];
    const hit = hooks.find((h) => h.label === MB.webhookLabel);
    if (hit) return hit;
    if (hooks.length < MB_PAGE) return null;
  }
  throw new Error(`MultiBaas has ${MB_PAGE * MB_MAX_PAGES} webhooks or more; kura_web was not among them`);
}

async function readCurrent(io: Io, want: Desired): Promise<Current> {
  const opts = { timeoutMs: 15_000, fetch: io.fetch };
  const contract = await mbRequest<{ rawAbi: string }>(io.cfg, "GET", `/contracts/${want.contract.label}/${encodeURIComponent(want.contract.version)}`, opts);
  const address = await mbRequest<{ address: string; contracts?: { label: string; version: string }[] }>(io.cfg, "GET", `/chains/ethereum/addresses/${want.address.alias}`, opts);
  const queries: Record<string, MbEventQuery | null> = {};
  for (const label of Object.keys(want.queries)) queries[label] = await mbRequest<MbEventQuery>(io.cfg, "GET", `/queries/${encodeURIComponent(label)}`, opts);
  const webhook = await findHook(io, opts.timeoutMs);
  return { contract, address, queries, webhook };
}

/** Each field's type and a short value, so each column's numeric shape (string or number) is visible. */
export const describeRow = (row: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, `${typeof v}:${String(v).slice(0, 40)}`]));

async function verify(io: Io, want: Desired, chainHead: number | undefined) {
  const opts = { fetch: io.fetch, timeoutMs: 15_000 };
  // The status endpoint answers 400 "invalid address" (not 404) while the alias doesn't exist, so check the link first.
  const address = await mbRequest<{ contracts?: { label: string }[] }>(io.cfg, "GET", `/chains/ethereum/addresses/${want.address.alias}`, opts);
  const linked = (address?.contracts ?? []).some((x) => x.label === want.contract.label);
  const st = linked
    ? await mbRequest<{ isProcessingPastLogs: boolean; latestBlockNumber: number; startBlockNumber: number }>(
        io.cfg,
        "GET",
        `/chains/ethereum/addresses/${want.address.alias}/contracts/${want.contract.label}/status`,
        opts,
      )
    : null;
  io.log(
    st
      ? `indexing: from block ${st.startBlockNumber}, at ${st.latestBlockNumber} (chain head ${chainHead}), catching up: ${st.isProcessingPastLogs}`
      : "indexing: the CardVault is not linked yet",
  );
  for (const label of Object.keys(want.queries)) {
    const r = await mbRequest<{ rows: Record<string, unknown>[] }>(io.cfg, "GET", `/queries/${encodeURIComponent(label)}/results?limit=3`, opts);
    if (!r) io.log(`${label}: missing`);
    else io.log(`${label}: ${r.rows.length} sample row(s) ${JSON.stringify(r.rows.map(describeRow))}`);
  }
  const h = await findHook(io, opts.timeoutMs);
  if (!h) {
    io.log("webhook: not created");
    return;
  }
  io.log(`webhook ${h.id} → ${h.url}; failed calls since the last success: ${h.failedCalls ?? 0}${h.lastError ? `; last error: ${h.lastError}` : ""}`);
  const events = await mbRequest<{ id: number; eventType: string; createdAt: string; deliveredAt?: string }[]>(io.cfg, "GET", `/webhooks/${h.id}/events?limit=5`, opts);
  for (const e of events ?? []) io.log(`  delivery ${e.id} ${e.eventType}: created ${e.createdAt}, delivered ${e.deliveredAt ?? "not yet"}`);
}

function secretLines(secret: string | undefined): string[] {
  if (!secret) return ["MultiBaas did not return the webhook's secret; read it in the MultiBaas UI (Blockchain → Webhooks)."];
  return [
    "",
    "The webhook's signing secret. Put it in your environment only, never in a committed file:",
    `  MULTIBAAS_WEBHOOK_SECRET=${secret}`,
    "Set it in Vercel (Production) and redeploy; add it to your local .env for development.",
    "",
  ];
}

/**
 * The whole CLI after argument and env parsing, so tests can drive it with a fake fetch. Answers the exit code.
 * Only `--apply` gets the caller's fetch as is; every other mode goes through `readOnly`.
 */
export async function runSetup(
  args: Args,
  deps: { cfg: MbConfig; deployments: unknown; fetch?: MbFetch; log?: (line: string) => void; error?: (line: string) => void },
): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const error = deps.error ?? ((l: string) => console.error(l));
  const base: MbFetch = deps.fetch ?? fetch;
  const io: Io = { cfg: deps.cfg, fetch: args.apply ? base : readOnly(base), log };
  const want = desiredState(deps.deployments, args.webhookBase);
  const status = await mbRequest<{ chainID: number; blockNumber?: number }>(io.cfg, "GET", "/chains/ethereum/status", { fetch: io.fetch, timeoutMs: 15_000 });
  if (status?.chainID !== SEPOLIA) throw new Error(`MultiBaas is on chain ${status?.chainID}, expected Sepolia (${SEPOLIA})`);
  if (args.verify) {
    await verify(io, want, status.blockNumber);
    return 0;
  }

  const have = await readCurrent(io, want);
  const { steps, conflicts } = planSetup(want, have);
  for (const c of conflicts) error(`conflict: ${c}`);
  if (conflicts.length > 0) {
    error("Nothing was changed.");
    return 1;
  }
  if (!want.webhook) log("webhook: skipped (pass --webhook-base https://your-app to create it)");
  if (steps.length === 0) log("MultiBaas is set up; nothing to do.");
  for (const s of steps) log(`${args.apply ? "→" : "would"} ${s.describe}`);
  if (args.showSecret) {
    if (have.webhook) secretLines(have.webhook.secret).forEach((l) => log(l));
    else log("--show-secret: the webhook does not exist yet; --apply prints its secret when it creates it.");
  }
  if (!args.apply) {
    if (steps.length > 0) log("\nDry run: nothing was changed. Rerun with --apply to apply.");
    return 0;
  }
  for (const s of steps) {
    const res = await mbRequest<{ id?: number; secret?: string }>(io.cfg, s.method, s.path, { body: s.body, timeoutMs: 30_000, fetch: io.fetch });
    log(`done: ${s.describe}`);
    if (s.kind === "webhook-create") secretLines(res?.secret).forEach((l) => log(l));
  }
  return 0;
}

async function main() {
  const args = parseSetupArgs(process.argv.slice(2));
  const envFile = join(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables already set in the shell
  const url = process.env.MULTIBAAS_URL;
  const apiKey = process.env.MULTIBAAS_API_KEY;
  if (!url || !apiKey) throw new Error("MULTIBAAS_URL and MULTIBAAS_API_KEY must be set (see .env.example)");
  const deployments: unknown = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/sepolia.json"), "utf8"));
  process.exitCode = await runSetup(args, { cfg: { url, apiKey }, deployments });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
