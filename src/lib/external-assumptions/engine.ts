import type { Pool, PoolClient } from "pg";
import {
  defaultReviewStatus,
  normalizeAssumptionType,
  normalizeReviewStatus,
  normalizeSourceKind,
  type ExternalAssumptionType,
  type ExternalReviewStatus,
  type ExternalSourceKind,
} from "./rules";

async function audit(client: PoolClient, action: string, entityId: string | null, before: unknown, after: unknown): Promise<void> {
  await client.query(
    `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
     values (null,$1,'external_assumptions',$2,$3,$4)`,
    [action, entityId, JSON.stringify(before ?? null), JSON.stringify(after ?? null)],
  );
}

export interface ExternalAssumption {
  id: string;
  assumption_type: ExternalAssumptionType;
  label: string;
  period_start: string | null;
  period_end: string | null;
  value_numeric: number;
  unit: string;
  currency: string;
  source_kind: ExternalSourceKind;
  source_name: string;
  source_url: string | null;
  source_date: string;
  review_status: ExternalReviewStatus;
  reviewed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export async function listExternalAssumptions(pool: Pool, limit = 80): Promise<ExternalAssumption[]> {
  const r = await pool.query(
    `select id, assumption_type, label,
            to_char(period_start,'YYYY-MM-DD') as period_start,
            to_char(period_end,'YYYY-MM-DD') as period_end,
            value_numeric::float8 as value_numeric,
            unit, currency, source_kind, source_name, source_url,
            to_char(source_date,'YYYY-MM-DD') as source_date,
            review_status,
            to_char(reviewed_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as reviewed_at,
            notes,
            to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at,
            to_char(updated_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as updated_at
     from public.external_assumptions
     where archived_at is null
     order by case review_status when 'pending_review' then 0 when 'approved' then 1 else 2 end,
              source_date desc, created_at desc
     limit $1`,
    [limit],
  );
  return r.rows as ExternalAssumption[];
}

export async function loadApprovedExternalAssumptions(pool: Pool, limit = 12): Promise<ExternalAssumption[]> {
  const r = await pool.query<ExternalAssumption>(
    `select distinct on (assumption_type) id, assumption_type, label,
            to_char(period_start,'YYYY-MM-DD') as period_start,
            to_char(period_end,'YYYY-MM-DD') as period_end,
            value_numeric::float8 as value_numeric,
            unit, currency, source_kind, source_name, source_url,
            to_char(source_date,'YYYY-MM-DD') as source_date,
            review_status,
            to_char(reviewed_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as reviewed_at,
            notes,
            to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at,
            to_char(updated_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as updated_at
     from public.external_assumptions
     where review_status='approved' and archived_at is null
     order by assumption_type, source_date desc, created_at desc
     limit $1`,
    [limit],
  );
  return r.rows;
}

export async function loadExternalAssumptionCenter(pool: Pool) {
  const [rows, counts, latestApproved] = await Promise.all([
    listExternalAssumptions(pool),
    pool.query<{ review_status: ExternalReviewStatus; source_kind: ExternalSourceKind; n: number }>(
      `select review_status, source_kind, count(*)::int n
       from public.external_assumptions where archived_at is null group by review_status, source_kind`,
    ),
    loadApprovedExternalAssumptions(pool),
  ]);
  const pendingCount = counts.rows.filter((r) => r.review_status === "pending_review").reduce((sum, r) => sum + r.n, 0);
  const internetPendingCount = counts.rows
    .filter((r) => r.review_status === "pending_review" && r.source_kind === "internet")
    .reduce((sum, r) => sum + r.n, 0);
  return {
    assumptions: rows,
    counts: counts.rows,
    latestApproved,
    pendingCount,
    internetPendingCount,
  };
}

export interface CreateExternalAssumptionInput {
  assumptionType: string;
  label: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  valueNumeric: number;
  unit: string;
  currency?: string | null;
  sourceKind: string;
  sourceName: string;
  sourceUrl?: string | null;
  sourceDate: string;
  reviewStatus?: string | null;
  notes?: string | null;
}

export async function createExternalAssumption(pool: Pool, input: CreateExternalAssumptionInput): Promise<string | null> {
  const assumptionType = normalizeAssumptionType(input.assumptionType);
  const sourceKind = normalizeSourceKind(input.sourceKind);
  const reviewStatus = input.reviewStatus
    ? (normalizeReviewStatus(input.reviewStatus) ?? defaultReviewStatus(sourceKind))
    : defaultReviewStatus(sourceKind);
  const label = input.label.trim().slice(0, 200);
  const sourceName = input.sourceName.trim().slice(0, 200);
  const unit = input.unit.trim().slice(0, 40);
  if (!label || !sourceName || !unit || !Number.isFinite(input.valueNumeric) || !input.sourceDate) return null;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const reviewedAt = reviewStatus === "approved" && sourceKind === "internet" ? new Date().toISOString() : null;
    const ins = await client.query<{ id: string }>(
      `insert into public.external_assumptions
         (assumption_type, label, period_start, period_end, value_numeric, unit, currency,
          source_kind, source_name, source_url, source_date, review_status, reviewed_at, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning id`,
      [
        assumptionType,
        label,
        input.periodStart || null,
        input.periodEnd || null,
        input.valueNumeric,
        unit,
        (input.currency || "TRY").trim().slice(0, 8).toUpperCase(),
        sourceKind,
        sourceName,
        input.sourceUrl?.trim() || null,
        input.sourceDate,
        reviewStatus,
        reviewedAt,
        input.notes?.trim() || null,
      ],
    );
    const id = ins.rows[0].id;
    await audit(client, "create_external_assumption", id, null, { assumptionType, sourceKind, reviewStatus, label });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function setExternalAssumptionReviewStatus(
  pool: Pool,
  id: string,
  status: ExternalReviewStatus,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(`select id, review_status, source_kind from public.external_assumptions where id=$1 for update`, [id]);
    if (before.rowCount === 1) {
      await client.query(
        `update public.external_assumptions
           set review_status=$2, reviewed_at=case when $2='approved' then now() else reviewed_at end
         where id=$1`,
        [id, status],
      );
      await audit(client, "set_external_assumption_review_status", id, before.rows[0], { id, reviewStatus: status });
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
