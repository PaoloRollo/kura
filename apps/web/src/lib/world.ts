import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { HttpError } from "@/lib/http";

export type Action = "bid" | "release";
export type Credential = "proofOfHuman" | "passport" | "selfieCheck";

export type IdkitResponseLike = {
  action?: string;
  environment?: string;
  responses: { identifier: string; signal_hash?: string; issuer_schema_id?: number; nullifier?: string }[];
  [k: string]: unknown;
};

export type WorldVerifyResult = {
  nullifier: bigint;
  credential: Credential;
  environment: string;
};

const SCHEMA_TO_CREDENTIAL: Record<number, Credential> = { 1: "proofOfHuman", 9303: "passport", 11: "selfieCheck" };

let fetchImpl: typeof fetch = fetch;
export function setWorldFetchForTests(f: typeof fetch) {
  fetchImpl = f;
}

export function acceptedCredentials(action: Action): Credential[] {
  if (action === "bid") return ["proofOfHuman", "passport", "selfieCheck"];
  const raw = process.env.WORLD_RELEASE_CREDENTIALS ?? "passport";
  return raw.split(",").map((s) => s.trim()).filter((s): s is Credential => ["proofOfHuman", "passport", "selfieCheck"].includes(s));
}

export function toNullifier(value: string): bigint {
  return value.startsWith("0x") ? BigInt(value) : BigInt(value);
}

/** Checks the signal binding locally, forwards the proof to World, and normalises the result. */
export async function verifyWorld(params: { rpId: string; action: Action; subject: `0x${string}`; idkitResponse: IdkitResponseLike; expectedEnv: string }): Promise<WorldVerifyResult> {
  // World verifies the proof against the action in the forwarded payload, so it must be the one we are issuing for;
  // otherwise a release proof (a separate nullifier space) could mint a second bid ticket for the same human.
  if (params.idkitResponse.action !== params.action) {
    throw new HttpError("WORLD_REJECTED", `proof was made for action ${params.idkitResponse.action ?? "none"}, not ${params.action}`, 400);
  }
  const expected = hashSignal(params.subject).toLowerCase();
  const items = params.idkitResponse.responses ?? [];
  if (items.length === 0 || !items.every((r) => (r.signal_hash ?? "").toLowerCase() === expected)) {
    throw new HttpError("SIGNAL_MISMATCH", "proof was not generated for this wallet", 400);
  }
  const schema = items[0].issuer_schema_id ?? 1;
  const credential = SCHEMA_TO_CREDENTIAL[schema];
  if (!credential || !acceptedCredentials(params.action).includes(credential)) {
    throw new HttpError("WRONG_CREDENTIAL", `credential ${credential ?? schema} is not accepted for ${params.action}`, 400);
  }

  const res = await fetchImpl(`https://developer.world.org/api/v4/verify/${params.rpId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params.idkitResponse),
  });
  const json = (await res.json()) as { success?: boolean; nullifier?: string; environment?: string; action?: string; code?: string; detail?: string };
  if (!res.ok || !json.success || !json.nullifier) {
    throw new HttpError("WORLD_REJECTED", json.detail ?? json.code ?? "verification failed", 400);
  }
  if (json.environment !== params.expectedEnv) {
    throw new HttpError("WRONG_ENVIRONMENT", `expected ${params.expectedEnv}, got ${json.environment}`, 400);
  }
  return { nullifier: toNullifier(json.nullifier), credential, environment: json.environment };
}
