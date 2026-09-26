import "server-only";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { HttpError } from "@/lib/http";

export type Action = "bid" | "release";
export type Credential = "proofOfHuman" | "passport" | "selfieCheck";

export type IdkitResponseLike = {
  protocol_version?: string;
  action?: string;
  environment?: string;
  responses: { identifier?: string; signal_hash?: string; issuer_schema_id?: number; nullifier?: string }[];
  [k: string]: unknown;
};

export type WorldVerifyResult = {
  nullifier: bigint;
  credential: Credential;
  environment: string;
};

// World ID 4.0: credential by issuer schema id.
const SCHEMA_TO_CREDENTIAL: Record<number, Credential> = { 1: "proofOfHuman", 9303: "passport", 11: "selfieCheck" };
// World ID 3.0 (legacy) proofs carry no schema id; map their identifier through an explicit allowlist.
// Anything else (device, face, ...) is not strong enough and is refused.
const LEGACY_IDENTIFIER_TO_CREDENTIAL: Record<string, Credential> = { orb: "proofOfHuman", document: "passport", secure_document: "passport" };

let fetchImpl: typeof fetch = fetch;
export function setWorldFetchForTests(f: typeof fetch) {
  fetchImpl = f;
}

/** Reads a required env var, failing with a stable CONFIG error instead of sending `undefined` onward. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new HttpError("CONFIG", `${name} is not configured`, 500);
  return value;
}

export function acceptedCredentials(action: Action): Credential[] {
  if (action === "bid") return ["proofOfHuman", "passport", "selfieCheck"];
  const raw = process.env.WORLD_RELEASE_CREDENTIALS ?? "passport";
  return raw.split(",").map((s) => s.trim()).filter((s): s is Credential => ["proofOfHuman", "passport", "selfieCheck"].includes(s));
}

/** Parses World's nullifier (0x-hex or decimal); anything else is a malformed World response. */
export function toNullifier(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new HttpError("WORLD_REJECTED", "World returned a malformed nullifier", 400);
  }
}

function credentialOf(response: IdkitResponseLike): Credential | undefined {
  const item = response.responses[0];
  if (response.protocol_version === "3.0") return item.identifier ? LEGACY_IDENTIFIER_TO_CREDENTIAL[item.identifier] : undefined;
  return item.issuer_schema_id === undefined ? undefined : SCHEMA_TO_CREDENTIAL[item.issuer_schema_id];
}

type WorldVerifyJson = {
  success?: boolean; nullifier?: string; environment?: string; action?: string; code?: string; detail?: string;
  results?: { identifier?: string; success?: boolean; code?: string; detail?: string }[];
};

/** Checks the signal binding locally, forwards the proof to World, and normalises the result. */
export async function verifyWorld(params: { rpId: string; action: Action; subject: `0x${string}`; idkitResponse: IdkitResponseLike; expectedEnv: string }): Promise<WorldVerifyResult> {
  // World verifies the proof against the action in the forwarded payload, so it must be the one we are issuing for;
  // otherwise a release proof (a separate nullifier space) could mint a second bid ticket for the same human.
  if (params.idkitResponse.action !== params.action) {
    throw new HttpError("WORLD_REJECTED", `proof was made for action ${params.idkitResponse.action ?? "none"}, not ${params.action}`, 400);
  }
  const items = params.idkitResponse.responses ?? [];
  if (items.length !== 1) throw new HttpError("WORLD_REJECTED", "expected exactly one credential response", 400);

  const expected = hashSignal(params.subject).toLowerCase();
  if ((items[0].signal_hash ?? "").toLowerCase() !== expected) {
    throw new HttpError("SIGNAL_MISMATCH", "proof was not generated for this wallet", 400);
  }
  // Legacy (v3) nullifiers live apart from v4 ones, so accepting both would let one human bind two bidder wallets.
  // The client's allow_legacy_proofs is UX only; this is the gate. Read at call time so it can be toggled.
  if (params.action === "bid" && params.idkitResponse.protocol_version === "3.0" && process.env.WORLD_BID_ALLOW_LEGACY !== "true") {
    throw new HttpError("WRONG_CREDENTIAL", "bidding requires a World ID 4.0 proof", 400);
  }
  const credential = credentialOf(params.idkitResponse);
  if (!credential || !acceptedCredentials(params.action).includes(credential)) {
    const got = credential ?? items[0].issuer_schema_id ?? items[0].identifier ?? "unknown";
    throw new HttpError("WRONG_CREDENTIAL", `credential ${got} is not accepted for ${params.action}`, 400);
  }

  const res = await fetchImpl(`https://developer.world.org/api/v4/verify/${params.rpId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // World only accepts staging/sandbox proofs while a staging window is open, and they must carry its token.
      ...(params.expectedEnv !== "production" && process.env.WORLD_STAGING_VERIFICATION_TOKEN
        ? { "x-staging-verification-token": process.env.WORLD_STAGING_VERIFICATION_TOKEN }
        : {}),
    },
    body: JSON.stringify(params.idkitResponse),
  });
  let json: WorldVerifyJson;
  try {
    json = (await res.json()) as WorldVerifyJson;
  } catch {
    throw new HttpError("WORLD_REJECTED", `World returned a non-JSON response (${res.status})`, 400);
  }
  if (!res.ok || !json?.success || typeof json.nullifier !== "string") {
    // World reports a code per proof in `results`; surface them, since the top-level detail is generic.
    const per = (json?.results ?? []).filter((r) => !r.success).map((r) => `${r.identifier ?? "proof"}: ${r.code ?? "?"}${r.detail ? ` (${r.detail})` : ""}`);
    const why = [json?.detail ?? json?.code ?? "verification failed", ...per].join(" · ");
    throw new HttpError("WORLD_REJECTED", why, 400);
  }
  if (json.action !== params.action) {
    throw new HttpError("WORLD_REJECTED", `World verified action ${json.action}, not ${params.action}`, 400);
  }
  if (json.environment !== params.expectedEnv) {
    throw new HttpError("WRONG_ENVIRONMENT", `expected ${params.expectedEnv}, got ${json.environment}`, 400);
  }
  return { nullifier: toNullifier(json.nullifier), credential, environment: json.environment };
}
