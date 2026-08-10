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

export function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    const loginUrl = new URL("/login", request.url);
    const next = request.nextUrl.pathname + request.nextUrl.search;
    if (next !== "/") loginUrl.searchParams.set("next", next);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|health|version|_next/static|_next/image|favicon.ico).*)"],
};
