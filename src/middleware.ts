// Coarse, Edge-safe first line of defense: correlation ID propagation, API rate limiting,
// and fail-closed session cookie check (with explicit loopback-only MAS_LOCAL_PASSWORDLESS=1 opt-in).
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth-constants";
import { CORRELATION_HEADER, readOrCreateCorrelationId } from "@/lib/correlation";
import { RATE_RULES, clientKey, rateLimit } from "@/lib/rate-limit";

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * Fast, Edge-safe, non-reversible 64-bit digest (two avalanche-finalized 32-bit FNV/Murmur lanes)
 * so authenticated `/api/*` callers get isolated per-session rate-limit buckets instead of sharing
 * `api:unknown` when `MAS_TRUST_PROXY=false`, without storing raw session tokens in memory.
 */
function sessionBucketDigest(token: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
  h1 = Math.imul(h1 ^ (h1 >>> 13), 0xc2b2ae35) ^ (h1 >>> 16);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0xc2b2ae35);
  h2 = Math.imul(h2 ^ (h2 >>> 13), 0x85ebca6b) ^ (h2 >>> 16);
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export function middleware(request: NextRequest) {
  const requestId = readOrCreateCorrelationId(request.headers);
  const forwarded = new Headers(request.headers);
  forwarded.set(CORRELATION_HEADER, requestId);

  const token = request.cookies.get(SESSION_COOKIE)?.value;

  if (isApiPath(request.nextUrl.pathname)) {
    const trimmedToken = token?.trim() ?? "";
    const bucketKey = trimmedToken
      ? `api:sess:${sessionBucketDigest(trimmedToken)}`
      : `api:${clientKey(request.headers)}`;
    const limit = rateLimit(bucketKey, RATE_RULES.api);
    if (!limit.ok) {
      return NextResponse.json(
        { error: { message: "Çok fazla istek. Lütfen biraz bekleyin.", code: "rate_limited" } },
        {
          status: 429,
          headers: {
            "retry-after": String(limit.retryAfterSec),
            [CORRELATION_HEADER]: requestId,
          },
        },
      );
    }
  }

  const allowLocalPasswordless =
    process.env.NODE_ENV !== "production" &&
    process.env.MAS_LOCAL_PASSWORDLESS === "1" &&
    (process.env.NODE_ENV !== "test" || process.env.MAS_ALLOW_PASSWORDLESS_IN_TEST === "1") &&
    isLoopbackHostname(request.nextUrl.hostname);

  if (!token && !allowLocalPasswordless) {
    const loginUrl = new URL("/login", request.url);
    const next = request.nextUrl.pathname + request.nextUrl.search;
    if (next !== "/") loginUrl.searchParams.set("next", next);
    if (
      !isApiPath(request.nextUrl.pathname) &&
      process.env.NODE_ENV !== "test" &&
      isLoopbackHostname(request.nextUrl.hostname)
    ) {
      loginUrl.searchParams.set("autologin", "1");
    }
    const redirect = NextResponse.redirect(loginUrl);
    redirect.headers.set(CORRELATION_HEADER, requestId);
    return redirect;
  }

  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set(CORRELATION_HEADER, requestId);
  return response;
}

export const config = {
  matcher: [
    "/((?!(?:login|health|ready|version)(?:$|/)|(?:robots\\.txt|manifest\\.json|icon\\.svg|favicon\\.ico)$|_next/static(?:/|$)|_next/image(?:$|/)).*)",
  ],
};
