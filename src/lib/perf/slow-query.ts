// Faz 33 — slow-query observation.
//
// ═══ WHY IN MEMORY, AND NOT A TABLE ═══
//
// The obvious design is a `slow_query_log` table. It was rejected for three measured reasons:
//
//   1. RECURSION. This records every query the app makes. Writing the record is itself a query,
//      which would be recorded, which would be written... Guarding against that means a flag that
//      must be right on every path.
//   2. WRITE AMPLIFICATION. Logging to the database makes the database slower, which is the
//      opposite of this phase.
//   3. RLS. Reads go through role-scoped connections (Faz 24B). A viewer running a slow SELECT
//      cannot insert a log row, so the logging would fail exactly for the tiers most likely to
//      surface an unusual query.
//
// A bounded in-process ring buffer has none of those problems. What it costs is persistence:
// restarting the server forgets the samples. For "which query shapes are slow right now", that is
// an acceptable trade — and it is stated on the diagnostics page rather than left to be
// discovered.
//
// ═══ PARAMETER VALUES ARE NEVER STORED ═══
//
// Only the SQL SHAPE is kept. The parameters of these queries are invoice amounts, counterparty
// names and account balances; a diagnostics screen is not a place financial data may leak into,
// and a fingerprint answers "which query" without answering "about whom".

/** How many distinct query shapes to track. Bounded so a pathological workload cannot grow it. */
const MAX_SHAPES = 200;
/** Below this, a query is not interesting. */
export const DEFAULT_SLOW_MS = 200;

export interface QueryStat {
  fingerprint: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  lastAt: string;
}

const stats = new Map<string, QueryStat>();
let slowThresholdMs = DEFAULT_SLOW_MS;
let droppedShapes = 0;

/**
 * Reduce a SQL statement to a comparable shape.
 *
 * Strips string literals, numbers and parameter placeholders, collapses whitespace, and truncates.
 * `where id = '9f2c…'` and `where id = '3a1b…'` become the same shape, which is the point: the
 * question is "is this QUERY slow", not "was it slow for this row".
 */
export function fingerprint(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "?")      // string literals (including '' escapes)
    .replace(/\$\d+/g, "?")                // bind placeholders
    .replace(/\b\d+\.?\d*\b/g, "?")       // numeric literals
    .replace(/--[^\n]*/g, " ")             // line comments
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function setSlowThreshold(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) slowThresholdMs = ms;
}
export function getSlowThreshold(): number {
  return slowThresholdMs;
}

/**
 * Record one query's duration. Called from the single choke point in db.ts.
 *
 * Never throws: instrumentation that can break the thing it instruments is worse than no
 * instrumentation. Every call site is a real financial query and none of them should fail because
 * a counter did.
 */
export function recordQuery(sql: string, ms: number): void {
  try {
    if (!Number.isFinite(ms) || ms < slowThresholdMs) return;
    const fp = fingerprint(sql);
    const existing = stats.get(fp);
    if (existing) {
      existing.count += 1;
      existing.totalMs += ms;
      existing.maxMs = Math.max(existing.maxMs, ms);
      existing.lastMs = ms;
      existing.lastAt = new Date().toISOString();
      return;
    }
    if (stats.size >= MAX_SHAPES) { droppedShapes += 1; return; }
    stats.set(fp, {
      fingerprint: fp, count: 1, totalMs: ms, maxMs: ms, lastMs: ms,
      lastAt: new Date().toISOString(),
    });
  } catch { /* observation must never break the observed */ }
}

/** Slowest shapes by CUMULATIVE time — a 40ms query run 500 times outranks one 900ms outlier. */
export function slowQueryReport(limit = 20): {
  threshold: number; shapes: number; dropped: number; rows: QueryStat[];
} {
  const rows = [...stats.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, limit);
  return { threshold: slowThresholdMs, shapes: stats.size, dropped: droppedShapes, rows };
}

export function resetSlowQueryStats(): void {
  stats.clear();
  droppedShapes = 0;
}
