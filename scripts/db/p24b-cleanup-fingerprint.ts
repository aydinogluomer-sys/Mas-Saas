// P24B — the single canonical fingerprint implementation.
//
// WHY THIS FILE EXISTS. v2.1 computed the whole-database fingerprint twice: once in
// p24b-cleanup-binding.ts to record the pre-cleanup state, and once in p24b-fixture-cleanup.ts to
// compare against it. Two implementations of the same hash are two implementations that can drift,
// and the failure mode is the worst kind: the comparison starts returning "different" for
// identical databases, or — far worse — "same" for different ones, because one side changed its
// ordering, its separator, or which schemas it walked.
//
// A binding is only as trustworthy as the guarantee that both sides hashed the same way. So both
// sides now import from here, and nowhere else defines it.
//
// DETERMINISM. Every digest is built from a canonical, sorted representation:
//   · tables ordered by schema then name
//   · rows hashed by their own text form, ordered by that text — so physical row order, and
//     therefore VACUUM, cannot change the result
//   · each table contributes "schema.table:rowCount:contentHash"
//   · the joined string is SHA256'd
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export interface TargetRef { table: string; id: string }

/** Base tables walked by the whole-database digest. Both sides must agree on this set. */
const SCHEMAS = ["public", "auth"] as const;

/** `schema.table` -> `rowCount:contentHash`, for reporting which tables moved. */
export async function wholeDbFingerprintMap(c: PoolClient): Promise<Record<string, string>> {
  const tabs = (await c.query<{ s: string; t: string }>(
    `select table_schema s, table_name t
       from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema = any($1::text[])
      order by table_schema, table_name`, [[...SCHEMAS]])).rows;
  const out: Record<string, string> = {};
  for (const { s, t } of tabs) {
    const r = await c.query<{ n: string; fp: string }>(
      `select count(*)::text n,
              coalesce(md5(string_agg(x::text, '|' order by x::text)), 'EMPTY') fp
         from "${s}"."${t}" x`);
    out[`${s}.${t}`] = `${r.rows[0].n}:${r.rows[0].fp}`;
  }
  return out;
}

/** One SHA256 over the whole database, derived from the map above. */
export function digestOfMap(map: Record<string, string>): string {
  const canonical = Object.keys(map).sort().map((k) => `${k}:${map[k]}`).join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export async function wholeDbFingerprintDigest(c: PoolClient): Promise<string> {
  return digestOfMap(await wholeDbFingerprintMap(c));
}

/**
 * The result of fingerprinting a target set.
 *
 * WHY THIS IS A STRUCT AND NOT A STRING. v2.2 returned only the digest and callers then asked
 * `digest.includes("MISSING")` / `digest.match(/MISSING/g)` to decide how many rows were present.
 * A SHA256 digest is hex — it cannot contain the letters "MISSING" — so those checks were
 * ALWAYS false and `found` was always the expected count. The binding therefore recorded
 * `targetRows: 42` no matter how many rows the restored copy actually held, which is exactly the
 * fact the restore smoke exists to establish.
 *
 * Presence is now counted where it is known, and the caller cannot re-derive it from a hash.
 */
export interface TargetFingerprintResult {
  digest: string;
  expected: number;
  found: number;
  missing: Array<{ table: string; id: string }>;
}

/**
 * One SHA256 over exactly the listed rows, plus the counts behind it.
 *
 * A row that is absent still contributes a canonical "MISSING" marker to the DIGEST, so a
 * fingerprint over a half-deleted target set can never collide with one over the intact set —
 * but `found` and `missing` come from the query results, never from the digest text.
 */
export async function targetFingerprint(
  c: PoolClient,
  targets: readonly TargetRef[],
): Promise<TargetFingerprintResult> {
  const parts: string[] = [];
  const missing: Array<{ table: string; id: string }> = [];
  for (const r of targets) {
    const idCol = r.table === "settings" ? "key" : "id";
    const cast = r.table === "settings" ? "text" : "uuid";
    const q = await c.query<{ fp: string }>(
      `select md5(x::text) fp from public.${r.table} x where x.${idCol} = $1::${cast}`, [r.id]);
    const fp = q.rows[0]?.fp;
    if (fp === undefined) missing.push({ table: r.table, id: r.id });
    parts.push(`${r.table}/${r.id}/${fp ?? "MISSING"}`);
  }
  return {
    digest: createHash("sha256").update(parts.sort().join("|")).digest("hex"),
    expected: targets.length,
    found: targets.length - missing.length,
    missing,
  };
}

/** A base table, as the catalog reports it. */
export interface BaseTableRef { schema: string; name: string }

/** Canonical, order-independent key for a set of base tables. */
export function tableSetKey(tables: readonly BaseTableRef[]): string {
  return tables.map((t) => `${t.schema}.${t.name}`).sort().join(",");
}

/**
 * Compare two catalog readings.
 *
 * The whole-database lock freezes DML on the tables that EXISTED when it was taken. It cannot
 * freeze the catalog: a concurrent migration could still add a table, and that table would be
 * outside both the lock and the fingerprint. Comparing the set at the start of the transaction
 * against the set immediately before COMMIT turns that blind spot into a detected failure.
 */
export function tableSetDiff(
  before: readonly BaseTableRef[],
  after: readonly BaseTableRef[],
): { equal: boolean; added: string[]; removed: string[] } {
  const b = new Set(before.map((t) => `${t.schema}.${t.name}`));
  const a = new Set(after.map((t) => `${t.schema}.${t.name}`));
  const added = [...a].filter((x) => !b.has(x)).sort();
  const removed = [...b].filter((x) => !a.has(x)).sort();
  return { equal: added.length === 0 && removed.length === 0, added, removed };
}

