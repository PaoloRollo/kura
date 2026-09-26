import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { EVENT_QUERIES, MB, MB_QUERIES, cardVaultAbi, type MbEventQuery } from "@kura/shared";
import { canonicalQuery, desiredState, parseSetupArgs, planSetup, readOnly, runSetup, type Current } from "./multibaas-setup";

const deployments = JSON.parse(readFileSync(new URL("../contracts/deployments/sepolia.json", import.meta.url), "utf8"));
const VAULT = deployments.cardVault as string;
const want = desiredState(deployments, "https://kuravault.xyz");
const empty: Current = { contract: null, address: null, queries: {}, webhook: null };

/** What MultiBaas echoes back for a saved query: explicit nulls, empty names and the default order. */
const echoed = (q: MbEventQuery) => ({
  ...q,
  order: q.order ?? "ASC",
  events: q.events.map((e) => ({ ...e, filter: null, select: e.select.map((s) => ({ name: "", inputIndex: null, aggregator: null, ...s })) })),
});
const done: Current = {
  contract: { rawAbi: JSON.stringify(cardVaultAbi) },
  address: { address: VAULT.toLowerCase(), contracts: [{ label: MB.contractLabel, version: MB.contractVersion }] },
  queries: Object.fromEntries(Object.entries(MB_QUERIES).map(([k, label]) => [label, echoed(EVENT_QUERIES[k as keyof typeof MB_QUERIES]) as unknown as MbEventQuery])),
  webhook: { id: 4, url: "https://kuravault.xyz/api/webhooks/multibaas", subscriptions: ["event.emitted"] },
};

describe("multibaas-setup args", () => {
  it("is a dry run unless --apply, and takes only an https webhook origin", () => {
    expect(parseSetupArgs([])).toEqual({ apply: false, verify: false, showSecret: false, webhookBase: null });
    expect(parseSetupArgs(["--", "--apply", "--webhook-base", "https://kuravault.xyz/ignored/path"])).toEqual({ apply: true, verify: false, showSecret: false, webhookBase: "https://kuravault.xyz" });
    expect(parseSetupArgs(["--verify", "--show-secret"])).toMatchObject({ verify: true, showSecret: true });
    expect(() => parseSetupArgs(["--apply", "--verify"])).toThrow(/pick one/);
    expect(() => parseSetupArgs(["--webhook-base", "http://kuravault.xyz"])).toThrow(/https/);
    expect(() => parseSetupArgs(["--webhook-base"])).toThrow(/needs a URL/);
    expect(() => parseSetupArgs(["--aply"])).toThrow(/unknown flag --aply/);
  });
});

describe("planSetup", () => {
  it("plans everything, in order, on an empty deployment", () => {
    const { steps, conflicts } = planSetup(want, empty);
    expect(conflicts).toEqual([]);
    expect(steps.map((s) => s.kind)).toEqual(["contract", "address", "link", "query", "query", "query", "query", "query", "query", "webhook-create"]);
    expect(steps[0]).toMatchObject({ method: "POST", path: "/contracts/kura_cardvault", body: { label: "kura_cardvault", contractName: "CardVault", version: "1.0" } });
    expect(JSON.parse((steps[0]!.body as { rawAbi: string }).rawAbi)).toEqual(cardVaultAbi);
    // MultiBaas rejects a contract without bytecode (NOT NULL); an ABI-only upload sends empty "0x".
    expect((steps[0]!.body as { bin: string }).bin).toBe("0x");
    expect(steps[1]).toMatchObject({ method: "POST", path: "/chains/ethereum/addresses", body: { alias: "kura_vault", address: VAULT } });
    expect(steps[2]).toMatchObject({ method: "POST", path: "/chains/ethereum/addresses/kura_vault/contracts", body: { label: "kura_cardvault", version: "1.0", startingBlock: String(deployments.deployBlock) } });
    expect(steps.filter((s) => s.kind === "query").map((s) => s.path).sort()).toEqual(Object.values(MB_QUERIES).map((l) => `/queries/${l}`).sort());
    expect(steps[9]).toMatchObject({ method: "POST", path: "/webhooks", body: { label: "kura_web", url: "https://kuravault.xyz/api/webhooks/multibaas", subscriptions: ["event.emitted"] } });
  });

  it("plans nothing when the deployment already matches, MultiBaas's echoed defaults included", () => {
    expect(planSetup(want, done)).toEqual({ steps: [], conflicts: [] });
    expect(canonicalQuery(done.queries[MB_QUERIES.mints])).toBe(canonicalQuery(EVENT_QUERIES.mints));
  });

  it("skips the webhook without --webhook-base", () => {
    expect(planSetup(desiredState(deployments, null), empty).steps.some((s) => s.kind.startsWith("webhook"))).toBe(false);
  });

  it("updates only what changed: one query, the webhook's URL", () => {
    const have: Current = { ...done, queries: { ...done.queries, [MB_QUERIES.mints]: { events: [] } }, webhook: { ...done.webhook!, url: "https://old.example/api/webhooks/multibaas" } };
    const { steps } = planSetup(want, have);
    expect(steps.map((s) => [s.kind, s.method, s.path])).toEqual([["query", "PUT", "/queries/kura_mints"], ["webhook-update", "PUT", "/webhooks/4"]]);
  });

  it("refuses to touch a contract, alias or link that points elsewhere", () => {
    const otherAbi = JSON.stringify((cardVaultAbi as readonly { type: string; name?: string }[]).filter((x) => !(x.type === "event" && x.name === "CardReleased")));
    expect(planSetup(want, { ...done, contract: { rawAbi: otherAbi } }).conflicts[0]).toMatch(/other events/);
    expect(planSetup(want, { ...done, address: { address: "0x0000000000000000000000000000000000000001", contracts: done.address!.contracts } }).conflicts[0]).toMatch(/points at 0x0000000000000000000000000000000000000001/);
    expect(planSetup(want, { ...done, address: { address: VAULT, contracts: [{ label: MB.contractLabel, version: "0.9" }] } }).conflicts[0]).toMatch(/linked to kura_cardvault 0.9/);
  });
});

/** A fake deployment: answers GETs from `state`, records every request, and plays MultiBaas's writes back into `state`. */
function fakeMultibaas(state: { contract?: unknown; address?: unknown; queries?: Record<string, unknown>; hooks?: unknown[]; chainID?: number }) {
  const calls: { method: string; path: string; body: unknown; auth: string }[] = [];
  const reply = (result: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify({ status, message: status === 200 ? "success" : "nope", result }), { status }));
  const f = vi.fn((url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v0/, "");
    const method = init.method ?? "GET";
    calls.push({ method, path: path + u.search, body: init.body ? JSON.parse(init.body as string) : undefined, auth: (init.headers as Record<string, string>).authorization! });
    if (method === "GET") {
      if (path === "/chains/ethereum/status") return reply({ chainID: state.chainID ?? 11155111, blockNumber: 11_800_000 });
      if (path === "/contracts/kura_cardvault/1.0") return state.contract ? reply(state.contract) : reply(null, 404);
      if (path === "/chains/ethereum/addresses/kura_vault") return state.address ? reply(state.address) : reply(null, 404);
      const q = /^\/queries\/([^/]+)$/.exec(path);
      if (q) return state.queries?.[q[1]!] ? reply(state.queries[q[1]!]) : reply(null, 404);
      if (path === "/webhooks") return reply(state.hooks ?? []);
      if (path === "/chains/ethereum/addresses/kura_vault/contracts/kura_cardvault/status")
        return state.address ? reply({ isProcessingPastLogs: false, latestBlockNumber: 11_799_990, startBlockNumber: 11779719 }) : reply(null, 400); // live: 400 "invalid address"
      const r = /^\/queries\/([^/]+)\/results$/.exec(path);
      if (r) return state.queries?.[r[1]!] ? reply({ rows: [{ vault: "kura_vault", raised: "1500000000" }] }) : reply(null, 404);
      return reply(null, 404);
    }
    if (method === "POST" && path === "/webhooks") return reply({ id: 7, secret: "whsec-FAKE-42", ...(JSON.parse(init.body as string) as object) });
    return reply(null);
  });
  return { f, calls };
}

const cfg = { url: "https://mb.test", apiKey: "KEY-DO-NOT-PRINT" };
const collect = () => {
  const out: string[] = [];
  return { out, log: (l: string) => out.push(l), error: (l: string) => out.push(`ERR ${l}`) };
};

describe("runSetup against a fake MultiBaas", () => {
  it("dry run (the default) sends only GETs and prints the plan", async () => {
    const mb = fakeMultibaas({});
    const io = collect();
    await expect(runSetup(parseSetupArgs(["--webhook-base", "https://www.kuravault.xyz"]), { cfg, deployments, fetch: mb.f, ...io })).resolves.toBe(0);
    expect(mb.calls.every((c) => c.method === "GET")).toBe(true);
    expect(mb.calls.find((c) => c.path.startsWith("/webhooks"))!.path).toBe("/webhooks?limit=50");
    expect(io.out.filter((l) => l.startsWith("would "))).toHaveLength(10);
    expect(io.out).toContain("would create webhook kura_web → https://www.kuravault.xyz/api/webhooks/multibaas (event.emitted)");
    expect(io.out.at(-1)).toMatch(/Dry run: nothing was changed/);
    expect(io.out.join("\n")).not.toContain("KEY-DO-NOT-PRINT");
  });

  it("--apply sends the planned writes in order, with the key, and prints the new webhook's secret once", async () => {
    const mb = fakeMultibaas({});
    const io = collect();
    await expect(runSetup(parseSetupArgs(["--apply", "--webhook-base", "https://www.kuravault.xyz"]), { cfg, deployments, fetch: mb.f, ...io })).resolves.toBe(0);
    const writes = mb.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /contracts/kura_cardvault",
      "POST /chains/ethereum/addresses",
      "POST /chains/ethereum/addresses/kura_vault/contracts",
      ...Object.values(MB_QUERIES).map((l) => `PUT /queries/${l}`),
      "POST /webhooks",
    ]);
    expect(writes.every((c) => c.auth === "Bearer KEY-DO-NOT-PRINT")).toBe(true);
    expect(writes[2]!.body).toEqual({ label: "kura_cardvault", version: "1.0", startingBlock: "11779719" });
    expect(writes[9]!.body).toEqual({ label: "kura_web", url: "https://www.kuravault.xyz/api/webhooks/multibaas", subscriptions: ["event.emitted"] });
    expect(io.out.filter((l) => l.includes("whsec-FAKE-42"))).toEqual(["  MULTIBAAS_WEBHOOK_SECRET=whsec-FAKE-42"]);
    expect(io.out.filter((l) => l.startsWith("done: "))).toHaveLength(10);
    expect(io.out.join("\n")).not.toContain("KEY-DO-NOT-PRINT");
  });

  it("--apply on a set-up deployment writes nothing and never prints the secret unasked", async () => {
    const mb = fakeMultibaas({ contract: done.contract, address: done.address, queries: done.queries, hooks: [{ ...done.webhook, label: "kura_web", url: "https://www.kuravault.xyz/api/webhooks/multibaas", secret: "whsec-OLD" }] });
    const io = collect();
    await expect(runSetup(parseSetupArgs(["--apply", "--webhook-base", "https://www.kuravault.xyz"]), { cfg, deployments, fetch: mb.f, ...io })).resolves.toBe(0);
    expect(mb.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(io.out).toContain("MultiBaas is set up; nothing to do.");
    expect(io.out.join("\n")).not.toContain("whsec-OLD");
  });

  it("--apply repoints an existing webhook with a PUT", async () => {
    const mb = fakeMultibaas({ contract: done.contract, address: done.address, queries: done.queries, hooks: [{ id: 4, label: "kura_web", url: "https://kuravault.xyz/api/webhooks/multibaas", subscriptions: ["event.emitted"] }] });
    await runSetup(parseSetupArgs(["--apply", "--webhook-base", "https://www.kuravault.xyz"]), { cfg, deployments, fetch: mb.f, ...collect() });
    expect(mb.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /webhooks/4"]);
  });

  it("--apply with a conflict changes nothing and exits 1", async () => {
    const mb = fakeMultibaas({ address: { address: "0x0000000000000000000000000000000000000001", contracts: [] } });
    const io = collect();
    await expect(runSetup(parseSetupArgs(["--apply"]), { cfg, deployments, fetch: mb.f, ...io })).resolves.toBe(1);
    expect(mb.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(io.out).toContain("ERR Nothing was changed.");
  });

  it("refuses a deployment on another chain before reading anything else", async () => {
    const mb = fakeMultibaas({ chainID: 1 });
    await expect(runSetup(parseSetupArgs(["--apply"]), { cfg, deployments, fetch: mb.f, ...collect() })).rejects.toThrow(/chain 1, expected Sepolia/);
    expect(mb.calls).toHaveLength(1);
  });

  it("--verify sends only GETs and reports what is missing", async () => {
    const mb = fakeMultibaas({});
    const io = collect();
    await runSetup(parseSetupArgs(["--verify"]), { cfg, deployments, fetch: mb.f, ...io });
    expect(mb.calls.every((c) => c.method === "GET")).toBe(true);
    expect(io.out).toEqual(["indexing: the CardVault is not linked yet", ...Object.values(MB_QUERIES).map((l) => `${l}: missing`), "webhook: not created"]);
  });

  it("--verify on a linked vault shows its indexing status and each column's value type", async () => {
    const mb = fakeMultibaas({ address: done.address, queries: done.queries });
    const io = collect();
    await runSetup(parseSetupArgs(["--verify"]), { cfg, deployments, fetch: mb.f, ...io });
    expect(io.out[0]).toBe("indexing: from block 11779719, at 11799990 (chain head 11800000), catching up: false");
    expect(io.out[1]).toBe('kura_settles: 1 sample row(s) [{"vault":"string:kura_vault","raised":"string:1500000000"}]');
    expect(mb.calls.filter((c) => c.path.includes("/results")).every((c) => Number(new URL(`https://x${c.path}`).searchParams.get("limit")) <= 50)).toBe(true);
  });

  it("the read-only fetch refuses writes before they leave the process", async () => {
    const f = vi.fn(async () => new Response("{}"));
    await expect(readOnly(f)("https://mb.test/api/v0/webhooks", { method: "POST" })).rejects.toThrow(/refusing POST without --apply/);
    expect(f).not.toHaveBeenCalled();
    await readOnly(f)("https://mb.test/api/v0/webhooks", { method: "GET" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
