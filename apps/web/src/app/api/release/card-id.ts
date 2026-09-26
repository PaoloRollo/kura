import { HttpError } from "@/lib/http";

/** The `cardId` query parameter, a decimal token id. */
export function cardIdParam(req: Request): bigint {
  const raw = new URL(req.url).searchParams.get("cardId") ?? "";
  if (!/^\d+$/.test(raw)) throw new HttpError("BAD_REQUEST", "cardId must be a decimal token id", 400);
  return BigInt(raw);
}
