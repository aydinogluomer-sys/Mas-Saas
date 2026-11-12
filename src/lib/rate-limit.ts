// Faz 16 / Faz 40 — in-memory rate limiting with bounded LRU-style eviction & proxy trust gate.
//
// `globalThis`, not `global`: src/middleware.ts imports this module and runs in the Edge
// runtime, where Node-only APIs and @/lib/env (which requires DATABASE_URL) cannot be loaded.

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

/** Hard cap on active rate-limit buckets to protect the 8 GB RAM host against IP-spray OOM. */
export const MAX_BUCKETS = 4096;

function store(): Map<string, Window> {
  if (!globalThis.__masRateLimit) globalThis.__masRateLimit = new Map();
  return globalThis.__masRateLimit;
}

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
    if (existing) map.delete(key);
    if (map.size >= MAX_BUCKETS) {
      sweep(now);
      while (map.size >= MAX_BUCKETS) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    }
    map.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { ok: true, remaining: rule.limit - 1, retryAfterSec: 0 };
  }

  // Refresh insertion order on hit so hot keys survive eviction over stale spray keys.
  map.delete(key);
  existing.count += 1;
  map.set(key, existing);

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

/** Test/inspection helper returning current bucket count. */
export function rateLimitBucketCount(): number {
  return store().size;
}

function isProxyTrusted(override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  if (typeof process === "undefined" || !process.env) return false;
  const raw = process.env.MAS_TRUST_PROXY;
  return raw === "1" || raw === "true";
}

/**
 * Client bucket identity.
 *
 * Faz 40 (A2): `x-forwarded-for` and `x-real-ip` are ONLY trusted when `MAS_TRUST_PROXY` is
 * explicitly enabled (`1` or `true`). In the default closed-circuit local deployment
 * (`MAS_TRUST_PROXY=false`), spoofed forwarding headers are ignored so an attacker cannot bypass
 * login or API rate limits by rotating fake `X-Forwarded-For` values.
 */
export function clientKey(headers: Headers, trustProxy?: boolean): string {
  if (!isProxyTrusted(trustProxy)) {
    return "unknown";
  }
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
