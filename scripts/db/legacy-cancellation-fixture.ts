// Shared, side-effect-free test-fixture helper for disposable-DB suites that restore a
// historical dump predating Slice 5's legacy-repair apply (backups/p0c-checkpoint-*.dump in
// migrate-verify.ts, backups/p0b-managed-baseline-*.dump in constraints-verify.ts). Both dumps
// were taken before mas_radar_dev's one known payment_instances anomaly (id below) was ever
// repaired, so both still carry it. Extracted here — rather than duplicated in both test
// files, or imported directly from migrate-verify.ts (unsafe: that script's own main() runs
// unconditionally at import time, with no isDirectRun guard) — so both suites share one
// definition. NOT production code: no audit/receipt protocol, just deterministic test-fixture
// preparation for a disposable DB that will never be mas_radar_dev.
import { Pool } from "pg";

// The one payment_instances row the real mas_radar_dev had with status='cancelled' and null
// cancelled_at/cancel_reason before Slice 5's legacy-repair apply fixed it (see
// 0026_cancellation_fields.sql's own comment). These mirror Slice 5's real, already-applied
// fix exactly, so that 0030's VALIDATE CONSTRAINT sees a fixture consistent with the real
// database it will eventually run against.
export const LEGACY_ANOMALY_INSTANCE_ID = "77815c3d-6762-4382-b49e-65905c07d8df";
export const LEGACY_ANOMALY_CANCELLED_AT = "2026-07-17T13:14:33.238853Z";
export const LEGACY_ANOMALY_CANCEL_REASON = "Legacy kayıt onarımı: özgün iptal nedeni kaynak verilerde bulunamadı.";

const CANCEL_CONSISTENCY_TABLES = ["payment_instances", "checks", "loan_installments"] as const;

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Counts rows across all three cancel-consistency-constrained tables where status='cancelled'
 * but cancelled_at/cancel_reason is missing — the exact shape 0026's constraints reject. Only
 * safe to call AFTER 0026 has been applied (checks/loan_installments don't have these columns
 * on either historical dump's raw, pre-0026 schema — see countPaymentInstancesCancelViolations
 * for the pre-migration equivalent). */
export async function countCancelConsistencyViolations(pool: Pool): Promise<number> {
  let total = 0;
  for (const table of CANCEL_CONSISTENCY_TABLES) {
    const r = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.${quoteIdent(table)} where status='cancelled' and (cancelled_at is null or cancel_reason is null)`,
    );
    total += r.rows[0]?.n ?? 0;
  }
  return total;
}

/** payment_instances-only equivalent of countCancelConsistencyViolations, safe to call on the
 * RAW restored historical dump before migrate.ts (and therefore 0026) has run — payment_instances
 * already had a status column with a 'cancelled' value long before 0026 added cancelled_at/
 * cancel_reason to it (and to checks/loan_installments, which never had a violating row in
 * mas_radar_dev — the real anomaly 0026 grandfathered was only ever in payment_instances). */
export async function countPaymentInstancesCancelViolations(pool: Pool): Promise<number> {
  const r = await pool.query<{ n: number }>(
    "select count(*)::int as n from public.payment_instances where status='cancelled' and (cancelled_at is null or cancel_reason is null)",
  );
  return r.rows[0]?.n ?? 0;
}

/** Full-row content fingerprint of payment_instances EXCLUDING one row — used to prove
 * prepareLegacyCheckpointForCancellationValidation touched only the one row it names. */
export async function fingerprintPaymentInstancesExcluding(pool: Pool, excludeId: string): Promise<string> {
  const r = await pool.query<{ fp: string }>(
    `select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) as fp
     from public.payment_instances t where t.id <> $1`,
    [excludeId],
  );
  return r.rows[0].fp;
}

export async function getTableRowCounts(pool: Pool, excludeTables: string[]): Promise<Record<string, number>> {
  const tablesRes = await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname='public' and tablename <> all($1::text[]) order by tablename",
    [excludeTables],
  );
  const counts: Record<string, number> = {};
  for (const { tablename } of tablesRes.rows) {
    const r = await pool.query<{ n: number }>(`select count(*)::int as n from public.${quoteIdent(tablename)}`);
    counts[tablename] = r.rows[0]?.n ?? 0;
  }
  return counts;
}

export interface ConstraintCatalogState {
  found: boolean;
  table: string | null;
  contype: string | null;
  convalidated: boolean | null;
}

export async function getConstraintCatalogState(pool: Pool, conname: string): Promise<ConstraintCatalogState> {
  const r = await pool.query<{ table_name: string; contype: string; convalidated: boolean }>(
    `select conrelid::regclass::text as table_name, contype::text, convalidated
     from pg_constraint where conname = $1`,
    [conname],
  );
  if (r.rows.length === 0) return { found: false, table: null, contype: null, convalidated: null };
  return { found: true, table: r.rows[0].table_name, contype: r.rows[0].contype, convalidated: r.rows[0].convalidated };
}

/** Test-setup-only fixture preparation — NOT a production repair, no audit/receipt. Callers
 * (migrate-verify.ts's p0c-checkpoint, constraints-verify.ts's p0b-managed-baseline) each
 * restore a historical dump predating Slice 5's legacy-repair apply, so both still carry the
 * one known payment_instances anomaly named above. This deterministically applies that SAME
 * already-applied real-world fix directly to the disposable DB at `connectionString`, so
 * 0030's VALIDATE CONSTRAINT sees a fixture consistent with the real, already-repaired
 * database it will eventually run against. Fails closed (throws) if the checkpoint's assumed
 * shape ever stops matching exactly one row, rather than silently updating zero or several. */
export async function prepareLegacyCheckpointForCancellationValidation(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query(
      `update public.payment_instances
       set cancelled_at = $2, cancel_reason = $3
       where id = $1 and status = 'cancelled' and cancelled_at is null and cancel_reason is null`,
      [LEGACY_ANOMALY_INSTANCE_ID, LEGACY_ANOMALY_CANCELLED_AT, LEGACY_ANOMALY_CANCEL_REASON],
    );
    if (result.rowCount !== 1) {
      throw new Error(
        `prepareLegacyCheckpointForCancellationValidation: beklenen tam 1 satır güncellenecekti, ${result.rowCount} güncellendi — checkpoint fixture beklenenden farklı, test durduruldu.`,
      );
    }
  } finally {
    await pool.end();
  }
}
