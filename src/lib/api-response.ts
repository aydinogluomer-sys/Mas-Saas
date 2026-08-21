// Faz 16 — one shared error/response envelope for route handlers.
//
// Two rules it exists to enforce, in one place instead of per-route:
//   1. A DomainError is an expected, user-facing failure and its message is safe to return.
//   2. Anything else is a bug or an infrastructure fault. The client gets a generic message
//      and nothing else — no stack, no driver text, no connection string, no table name —
//      while the server log gets the whole thing, tied to the request's correlation id.
//
// This does NOT change src/lib/domain-error.ts, and it does NOT retrofit the existing route
// handlers wholesale; migrating the remaining engines onto DomainError is Faz 18's job.
import { NextResponse } from "next/server";
import { DomainError } from "@/lib/domain-error";
import { CORRELATION_HEADER, readOrCreateCorrelationId } from "@/lib/correlation";
import { log } from "@/lib/logger";

export interface ApiErrorBody {
  error: { message: string; code?: string };
}

/** Deliberately vague, and deliberately the *same* text for every unexpected failure: a
 * message that varied with the cause would be an oracle for probing the backend. */
const GENERIC_ERROR = "Beklenmeyen bir hata oluştu.";

export function apiError(
  status: number,
  message: string,
  options: { code?: string; requestId?: string } = {},
): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = { error: { message, ...(options.code ? { code: options.code } : {}) } };
  const headers = options.requestId ? { [CORRELATION_HEADER]: options.requestId } : undefined;
  return NextResponse.json(body, { status, headers });
}

/** A DomainError means the caller asked for something the domain refuses (wrong source
 * status, missing record) — a 400, not a 500: the server is fine, the request was not. */
export function domainErrorStatus(): number {
  return 400;
}

/**
 * Wraps a route handler. Resolves the correlation id once, echoes it on every response
 * (success included, so a client can quote it), and converts thrown errors per the rules
 * above.
 */
export async function withApiHandler(
  request: Request,
  handler: (ctx: { requestId: string }) => Promise<NextResponse>,
): Promise<NextResponse> {
  const requestId = readOrCreateCorrelationId(request.headers);
  const route = new URL(request.url).pathname;
  try {
    const res = await handler({ requestId });
    res.headers.set(CORRELATION_HEADER, requestId);
    return res;
  } catch (e) {
    if (e instanceof DomainError) {
      // Expected: logged at warn, message passed through, no stack noise.
      log.warn("domain_error", { requestId, route, message: e.message });
      return apiError(domainErrorStatus(), e.message, { requestId });
    }
    log.error("unhandled_route_error", { requestId, route, error: e });
    return apiError(500, GENERIC_ERROR, { requestId });
  }
}

/**
 * Origin check for MUTATING route handlers (server actions are covered by Next.js itself —
 * see docs/status-notes.md for how that was verified rather than assumed).
 *
 * Returns null when the request may proceed. A same-origin browser request always carries
 * Origin on POST/PUT/PATCH/DELETE; a missing Origin on a mutation is therefore treated as
 * untrusted rather than waved through. Safe methods are never checked.
 */
export function checkOrigin(request: Request, requestId?: string): NextResponse<ApiErrorBody> | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    log.warn("csrf_missing_origin", { requestId, method, hasOrigin: Boolean(origin), hasHost: Boolean(host) });
    return apiError(403, "Origin doğrulanamadı.", { code: "csrf", requestId });
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    log.warn("csrf_bad_origin", { requestId, method });
    return apiError(403, "Origin doğrulanamadı.", { code: "csrf", requestId });
  }
  if (originHost !== host) {
    log.warn("csrf_origin_mismatch", { requestId, method, originHost, host });
    return apiError(403, "Origin doğrulanamadı.", { code: "csrf", requestId });
  }
  return null;
}
