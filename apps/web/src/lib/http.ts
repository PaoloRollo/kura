import { NextResponse } from "next/server";
import type { ZodSchema } from "zod";
import { AuthError, requireUser, type KuraUser } from "@/lib/auth";

export class HttpError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

export function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function parseBody<T>(schema: ZodSchema<T>, req: Request): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError("BAD_REQUEST", "body must be JSON", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError("BAD_REQUEST", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 400);
  return parsed.data;
}

type Handler = (req: Request, user: KuraUser) => Promise<Response>;

/** Wraps a route handler: authenticates, and turns AuthError/HttpError into stable JSON errors. */
export function withAuth(handler: Handler) {
  return async (req: Request): Promise<Response> => {
    try {
      const user = await requireUser(req);
      return await handler(req, user);
    } catch (e) {
      if (e instanceof AuthError) return jsonError(e.code, e.message, e.status);
      if (e instanceof HttpError) return jsonError(e.code, e.message, e.status);
      console.error(e);
      return jsonError("INTERNAL", "unexpected error", 500);
    }
  };
}
