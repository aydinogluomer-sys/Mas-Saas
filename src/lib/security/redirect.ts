// Faz 40 (A2) — canonical open-redirect guard.
//
// Pure, synchronous, and free of Node/Next runtime dependencies so it can be imported from server
// actions, route handlers, engines, Edge middleware, and unit tests alike.

const CONTROL_OR_BACKSLASH = /[\x00-\x1f\x7f\\]/;
const ENCODED_LEADING_SLASH = /^\/(%2f|%5c)/i;
const AUTH_LOOP_PREFIXES = ["/login", "/change-password"] as const;

function normalizeFallback(fallback: string): string {
  if (
    !fallback ||
    !fallback.startsWith("/") ||
    fallback.startsWith("//") ||
    fallback.includes("://") ||
    CONTROL_OR_BACKSLASH.test(fallback)
  ) {
    return "/overview";
  }
  return fallback;
}

/**
 * Ensures a redirect destination is a safe same-origin relative path.
 *
 * Rejects:
 *  - non-strings, empty strings, or overlong strings (> 2048 chars)
 *  - absolute URLs (`https://evil.com`, `javascript:...`, anything containing `://`)
 *  - protocol-relative URLs (`//evil.com`) and encoded leading slashes (`/%2fevil.com`, `/%5cevil.com`)
 *  - backslash-prefixed or backslash-containing paths (`/\evil.com`, `/foo\bar`)
 *  - ASCII control characters (`\x00-\x1f`, `\x7f`), including leading tabs/newlines (`\t//evil.com`)
 *  - authentication loop targets (`/login`, `/change-password` and subpaths/queries)
 */
export function safeRedirectPath(raw: unknown, fallback = "/overview"): string {
  const safeFallback = normalizeFallback(fallback);
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return safeFallback;
  }
  if (CONTROL_OR_BACKSLASH.test(raw)) {
    return safeFallback;
  }
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("://")) {
    return safeFallback;
  }
  if (ENCODED_LEADING_SLASH.test(raw)) {
    return safeFallback;
  }
  const pathname = raw.split(/[?#]/, 1)[0] ?? "";
  for (const prefix of AUTH_LOOP_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return safeFallback;
    }
  }
  return raw;
}

