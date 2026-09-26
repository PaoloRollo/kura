// MultiBaas (Curvegrid) definitions shared by scripts/multibaas-setup.ts and the web server: labels, the CardVault
// event signatures, the saved Event Queries the analytics dashboard reads, and a small fetch client for the REST API
// (spec: https://data.multibaas.com/api/v0/openapi.yaml). No secrets live here: callers pass the API key in.
import { toEventSignature, type AbiEvent } from "viem";
import { cardVaultAbi } from "./abi";

/** Labels and the alias match MultiBaas's pattern ^[a-z1-9_-][a-z0-9_-]*$. */
export const MB = {
  contractLabel: "kura_cardvault",
  contractName: "CardVault",
  contractVersion: "1.0",
  addressAlias: "kura_vault",
  webhookLabel: "kura_web",
  webhookPath: "/api/webhooks/multibaas",
} as const;

export type CardVaultEventName = "CardMinted" | "AuctionSettled" | "CardRedeemed" | "FeeAccrued";

const eventSig = (name: CardVaultEventName): string => {
  const item = (cardVaultAbi as unknown as readonly { type: string; name?: string }[]).find((x) => x.type === "event" && x.name === name);
  if (!item) throw new Error(`cardVaultAbi has no event ${name}`);
  return toEventSignature(item as AbiEvent);
};

/** Event Queries name events by canonical signature, "AuctionSettled(uint256,address,uint256,uint256,uint256,bool)". */
export const CARD_VAULT_EVENTS: Record<CardVaultEventName, string> = {
  CardMinted: eventSig("CardMinted"),
  AuctionSettled: eventSig("AuctionSettled"),
  CardRedeemed: eventSig("CardRedeemed"),
  FeeAccrued: eventSig("FeeAccrued"),
};

export type MbFieldType = "input" | "triggered_at" | "block_number" | "tx_hash" | "contract_address_alias";
export type MbField = { type: MbFieldType; name?: string; inputIndex?: number; alias: string; aggregator?: "add" };
export type MbEventQuery = { events: { eventName: string; select: MbField[] }[]; groupBy?: string; orderBy?: string; order?: "ASC" | "DESC" };

export const MB_QUERIES = {
  settles: "kura_settles",
  redeems: "kura_redeems",
  mints: "kura_mints",
  fees: "kura_fee_events",
  raisedTotal: "kura_raised_total",
  feesTotal: "kura_fees_total",
} as const;
export type MbQueryKey = keyof typeof MB_QUERIES;

const META: MbField[] = [{ type: "triggered_at", alias: "at" }, { type: "block_number", alias: "block" }, { type: "tx_hash", alias: "tx" }];
/** The position of `name` among `event`'s inputs: MultiBaas requires `inputIndex` on input fields (400 "missing field index"). */
const inputIndexOf = (event: CardVaultEventName, name: string): number => {
  const item = (cardVaultAbi as unknown as readonly { type: string; name?: string; inputs?: { name: string }[] }[]).find((x) => x.type === "event" && x.name === event);
  const i = item?.inputs?.findIndex((p) => p.name === name) ?? -1;
  if (i < 0) throw new Error(`cardVaultAbi event ${event} has no input ${name}`);
  return i;
};
const input = (event: CardVaultEventName, name: string, alias: string): MbField => ({ type: "input", name, inputIndex: inputIndexOf(event, name), alias });
/** One row per event, oldest block first. MultiBaas has no date bucketing and no count: we bucket and count rows. */
const list = (event: CardVaultEventName, fields: MbField[]): MbEventQuery => ({
  events: [{ eventName: CARD_VAULT_EVENTS[event], select: [...META, ...fields] }],
  orderBy: "block",
  order: "ASC",
});
/** Σ of one input across every event, grouped by the vault's alias (one row): MultiBaas's `add` aggregator. */
const total = (event: CardVaultEventName, name: string, alias: string): MbEventQuery => ({
  events: [{ eventName: CARD_VAULT_EVENTS[event], select: [{ type: "contract_address_alias", alias: "vault" }, { type: "input", name, inputIndex: inputIndexOf(event, name), alias, aggregator: "add" }] }],
  groupBy: "vault",
});

/**
 * The saved Event Queries. No filter on `graduated`: CardVault.settle emits raisedUsdc = 0 when the auction did not
 * graduate (CardVault.sol, settle), so Σ raisedUsdc is the graduated total; list rows carry `graduated` for counts.
 */
export const EVENT_QUERIES: Record<MbQueryKey, MbEventQuery> = {
  settles: list("AuctionSettled", [input("AuctionSettled", "id", "card"), input("AuctionSettled", "raisedUsdc", "raised"), input("AuctionSettled", "feeUsdc", "fee"), input("AuctionSettled", "graduated", "graduated")]),
  redeems: list("CardRedeemed", [input("CardRedeemed", "id", "card"), input("CardRedeemed", "payoutUsdc", "payout"), input("CardRedeemed", "feeUsdc", "fee")]),
  mints: list("CardMinted", [input("CardMinted", "id", "card")]),
  fees: list("FeeAccrued", [input("FeeAccrued", "id", "card"), input("FeeAccrued", "kind", "kind"), input("FeeAccrued", "amountUsdc", "amount")]),
  raisedTotal: total("AuctionSettled", "raisedUsdc", "raised"),
  feesTotal: total("FeeAccrued", "amountUsdc", "fees"),
};

export type MbConfig = { url: string; apiKey: string };
export type MbFetch = (url: string, init: RequestInit) => Promise<Response>;

export class MultibaasError extends Error {
  constructor(public readonly status: number | null, message: string) {
    super(message);
    this.name = "MultibaasError";
  }
}

export const MB_TIMEOUT_MS = 4_000;

/**
 * One REST call. Answers the `result` of MultiBaas's `{ status, message, result }` envelope (null when there is none),
 * null for a 404, and throws a MultibaasError (method, path, status and MultiBaas's message, never the headers) for any
 * other failure: a timeout (while connecting or reading the body) and a success whose body is not JSON included.
 */
export async function mbRequest<T>(
  cfg: MbConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { body?: unknown; timeoutMs?: number; fetch?: MbFetch } = {},
): Promise<T | null> {
  const f: MbFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${cfg.url.replace(/\/+$/, "")}/api/v0${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? MB_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    const why = name === "TimeoutError" || name === "AbortError" ? "timed out" : `failed: ${(e as Error)?.message ?? String(e)}`;
    throw new MultibaasError(null, `${method} ${path} ${why}`);
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined); // release the connection; the body says nothing we use
    return null;
  }
  let body: { message?: unknown; result?: unknown } | null = null;
  try {
    body = (await res.json()) as { message?: unknown; result?: unknown };
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new MultibaasError(null, `${method} ${path} timed out`);
    if (res.ok) throw new MultibaasError(res.status, `${method} ${path} answered non-JSON`);
    body = null;
  }
  if (!res.ok) throw new MultibaasError(res.status, `${method} ${path} → ${res.status}${typeof body?.message === "string" ? `: ${body.message}` : ""}`);
  return (body?.result ?? null) as T | null;
}

/** The deployment answers 400 "invalid request" for any `limit` above 50 (queries/{label}/results and /events alike). */
export const MB_PAGE = 50;
export const MB_MAX_PAGES = 100;

/** Every row of a saved Event Query, page by page (MultiBaas's default limit is 10, its maximum 50). Throws rather than truncate. */
export async function mbQueryRows(
  cfg: MbConfig,
  label: string,
  opts: { fetch?: MbFetch; timeoutMs?: number; pageSize?: number; maxPages?: number } = {},
): Promise<Record<string, unknown>[]> {
  const size = opts.pageSize ?? MB_PAGE;
  const max = opts.maxPages ?? MB_MAX_PAGES;
  const out: Record<string, unknown>[] = [];
  for (let page = 0; page < max; page++) {
    const r = await mbRequest<{ rows?: unknown }>(cfg, "GET", `/queries/${encodeURIComponent(label)}/results?offset=${page * size}&limit=${size}`, opts);
    if (!r) throw new MultibaasError(404, `saved Event Query ${label} is missing (run scripts/multibaas-setup.ts --apply)`);
    if (!Array.isArray(r.rows)) throw new MultibaasError(502, `Event Query ${label} answered no rows array`);
    out.push(...(r.rows as Record<string, unknown>[]));
    if (r.rows.length < size) return out;
  }
  throw new MultibaasError(502, `Event Query ${label} has ${size * max} rows or more; raise MB_MAX_PAGES`);
}
