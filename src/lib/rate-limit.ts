// Faz 16 — in-memory rate limiting.
//
// No Redis, no DB table, no external store: this app is a single-operator internal panel
// running as one Next.js process (docs/local-production-deploy.md), so a shared store would
// be infrastructure with no reader. If the deployment ever becomes multi-instance this
// module is the one place to swap — the call sites do not care how the counter is kept.
//
// Fixed window rather than a token bucket, chosen for a specific reason: the behaviour is
// exactly predictable ("the Nth+1 request inside the window is refused"), which is what
// scripts/phase16-verify.ts asserts. A leaky bucket would make that assertion timing
// dependent and therefore flaky.
//
// Counters live on globalThis for the same reason the pg Pool does (src/lib/db.ts): Next
// re-evaluates modules on hot reload, and a per-module Map would silently reset the limiter
// on every edit in dev.

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets — the value for a Retry-After header. */
  retryAfterSec: number;
}

interface Window {
  count: number;
  resetAt: number;
}

declare global {
  var __masRateLimit: Map<string, Window> | undefined;
}

/** `globalThis`, not `global`: src/middleware.ts imports this module and runs in the Edge
 * runtime, where the Node-only `global` alias is not guaranteed to exist. Nothing else in
 * this file touches a node: API, which is what keeps it importable from middleware at all. */
function store(): Map<string, Window> {
  if (!globalThis.__masRateLimit) globalThis.__masRateLimit = new Map();
  return globalThis.__masRateLimit;
}

/** Bounded-memory guarantee: expired windows are swept every SWEEP_EVERY calls. Without
 * this, a flood from many distinct IPs would grow the map forever — a rate limiter that
 * becomes the outage is not a rate limiter. */
const SWEEP_EVERY = 500;
let sinceSweep = 0;

function sweep(now: number): void {
  const map = store();
  for (const [key, win] of map) {
    if (win.resetAt <= now) map.delete(key);
  }
}

export function rateLimit(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitResult {
  if (++sinceSweep >= SWEEP_EVERY) {
    sinceSweep = 0;
    sweep(now);
  }
  const map = store();
  const existing = map.get(key);

  if (!existing || existing.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { ok: true, remaining: rule.limit - 1, retryAfterSec: 0 };
  }

  existing.count += 1;
  const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  if (existing.count > rule.limit) {
    return { ok: false, remaining: 0, retryAfterSec };
  }
  return { ok: true, remaining: rule.limit - existing.count, retryAfterSec };
}

/** Test/maintenance hook — also used by scripts/phase16-verify.ts's unit-level checks. */
export function resetRateLimits(): void {
  store().clear();
  sinceSweep = 0;
}

/**
 * Best-effort client identity. Behind no proxy (the normal local deployment) neither header
 * is present and every caller collapses to "unknown" — which is correct for a single-user
 * panel: the limit then applies to the whole front door, which is still the protection we
 * want against a password-guessing loop. It is NOT an authorization input, only a bucket key.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** Named rules, so limits are visible in one place instead of sprinkled as magic numbers. */
export const RATE_RULES = {
  /** Password guessing. Deliberately tight; the per-account lockout in public.users is the
   * second layer, and this one exists so an attacker cannot cheaply enumerate accounts. */
  login: { limit: 10, windowMs: 60_000 } satisfies RateLimitRule,
  /** JSON API surface. Generous enough for a dashboard polling it, tight enough to matter. */
  api: { limit: 60, windowMs: 60_000 } satisfies RateLimitRule,
} as const;
