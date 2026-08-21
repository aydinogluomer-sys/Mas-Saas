// Coarse, Edge-safe first line of defense: cookie-presence only, no DB lookup here (this
// runs in the Edge runtime — no Node.js APIs, no `pg`, no native bindings; the real,
// DB-backed check is requireSession()/requireAdmin() in src/lib/auth.ts, called at the top
// of every page/route that actually needs it).
//
// The matcher is default-deny — every path is covered except the explicit allowlist below.
// This is the structural fix for a real gap found in this exact codebase: src/app/api/facts
// lived outside the (dashboard) route group and had zero auth check at all, reachable with
// financial data even with the access gate on. A default-deny matcher means any *future*
// route added anywhere is protected automatically — no one has to remember to add a check.
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth-constants";
import { CORRELATION_HEADER, readOrCreateCorrelationId } from "@/lib/correlation";
import { RATE_RULES, clientKey, rateLimit } from "@/lib/rate-limit";

/** The JSON surface. Rate limited here — that is, BEFORE the cookie check below — because a
 * flood should be refused as cheaply as possible, and because a 429 is a more honest answer
 * to "you are hammering us" than a 307 to the login page.
 *
 * Neither @/lib/api-response nor @/lib/logger may be imported into this file: both reach for
 * process.stderr, which does not exist in the Edge runtime. The envelope below is therefore
 * written out by hand and must stay shape-compatible with src/lib/api-response.ts. */
function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function middleware(request: NextRequest) {
  // Faz 16: one correlation id per request, resolved before anything can fail, so even the
  // redirect below is traceable. Set on the *forwarded* request headers (server components
  // and route handlers read it from there) and echoed on the response for the operator.
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
  if (!token) {
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
  // `ready` joins the allowlist alongside `health` (Faz 16). Without it the probe would be
  // answered by a redirect to /login and every monitor would read the app as "up" while
  // measuring the login page.
  matcher: ["/((?!login|health|ready|version|_next/static|_next/image|favicon.ico).*)"],
};
