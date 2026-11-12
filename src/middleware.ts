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

export function middleware(request: NextRequest) {
  const requestId = readOrCreateCorrelationId(request.headers);
  const forwarded = new Headers(request.headers);
  forwarded.set(CORRELATION_HEADER, requestId);

  if (isApiPath(request.nextUrl.pathname)) {
    const limit = rateLimit(`api:${clientKey(request.headers)}`, RATE_RULES.api);
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

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const allowLocalPasswordless =
    process.env.MAS_LOCAL_PASSWORDLESS === "1" &&
    (process.env.NODE_ENV !== "test" || process.env.MAS_ALLOW_PASSWORDLESS_IN_TEST === "1") &&
    isLoopbackHostname(request.nextUrl.hostname);

  if (!token && !allowLocalPasswordless) {
    const loginUrl = new URL("/login", request.url);
    const next = request.nextUrl.pathname + request.nextUrl.search;
    if (next !== "/") loginUrl.searchParams.set("next", next);
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
    "/((?!(?:login|health|ready|version)(?:$|/)|(?:robots\\.txt|manifest\\.json|sw\\.js|icon\\.svg|favicon\\.ico)$|_next/static(?:/|$)|_next/image(?:$|/)).*)",
  ],
};
