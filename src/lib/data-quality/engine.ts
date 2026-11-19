import type { Pool, PoolClient } from "pg";
import { gather, withPinnedRead } from "@/lib/pg-concurrency";
import {
  classifyWorkbookChange,
  decisionConfidenceLabel,
  decisionConfidenceScore,
  rankReviewSignals,
  reviewActionTitle,
  type ActionStatus,
  type DqSeverity,
  type ReviewSignal,
  type WorkbookChangeImpact,
} from "./rules";
import { loadCapacityModels } from "@/lib/production/engine";
import { moneyOrNull } from "@/lib/money";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { safeRedirectPath } from "@/lib/security/redirect";

/**
 * Faz 41 (B3-04): Exact mirror of the SQL `source_cells.normalized_value` parser used in
 * `cashflowReconciliation`. Prevents the legacy `100x` decimal-stripping bug (`"123456.78" -> 12345678`)
 * while still supporting Turkish thousands-dot + comma-decimal strings (`"123.456,78" -> "123456.78"`)
 * and returning `null` for formula errors or non-numeric cells.
 */
export function parseNormalizedSourceCellNumeric(
  normalizedValue: string | null | undefined,
  inferredType?: string | null,
): string | null {
  if (normalizedValue === null || normalizedValue === undefined || inferredType === "error") {
    return null;
  }
  const s = normalizedValue.trim();
  if (s === "") return null;
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(s)) {
    return s;
  }
  if (/^-?[0-9]{1,3}(\.[0-9]{3})*(,[0-9]+)?$/.test(s)) {
    return s.replaceAll(".", "").replace(",", ".");
  }
  if (/^-?[0-9]+,[0-9]+$/.test(s)) {
    return s.replace(",", ".");
  }
  return null;
}

export interface ActionItem {
  id: string;
  title: string;
  severity: DqSeverity;
  owner: string | null;
  due_date: string | null;
  status: ActionStatus;
  source_type: string;
  source_fact_key: string | null;
  source_href: string | null;
  related_entity_table: string | null;
  related_entity_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditTrailItem {
  action: string;
  entity_table: string;
  entity_id: string | null;
  created_at: string;
}

export interface DataQualityBlocker extends ReviewSignal {
  workbook_id: string;
  workbook_name: string;
  sheet_id: string | null;
  source_href: string;
}

export async function loadSystemQualityHeader(pool: Pool | PoolClient) {
  const [summaryRes, capacityModels] = await gather(pool, [
    () =>
      pool.query<{
        open_review_count: number;
        high_open_count: number;
        reconciliation_signal_count: number;
        external_pending_count: number;
        missing_amount_count: number;
        wb_id: string | null;
        wb_filename: string | null;
        wb_imported_at: string | null;
        wb_status: string | null;
      }>(
        `with rev as (
           select
             count(*) filter (where status in ('open','rejected'))::int as open_review_count,
             count(*) filter (where status in ('open','rejected') and severity in ('critical','high'))::int as high_open_count,
             count(*) filter (
               where issue_type in ('cashflow_identity_mismatch','continuity_break','month_gap')
                 and status in ('open','rejected')
             )::int as reconciliation_signal_count
           from public.mapping_reviews
         ),
         wb as (
           select id::text as wb_id,
                  original_filename as wb_filename,
                  to_char(imported_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as wb_imported_at,
                  status as wb_status
           from public.source_workbooks
           order by imported_at desc
           limit 1
         )
         select
           rev.open_review_count,
           rev.high_open_count,
           rev.reconciliation_signal_count,
           (select count(*)::int from public.external_assumptions where review_status='pending_review') as external_pending_count,
           (
             (select count(*)::int from public.payment_instances where amount is null and status in ('unpaid','partial','planned','late')) +
             (select count(*)::int from public.cashflow_lines where amount is null)
           )::int as missing_amount_count,
           wb.wb_id,
           wb.wb_filename,
           wb.wb_imported_at,
           wb.wb_status
         from rev
         left join wb on true`,
      ),
    () => loadCapacityModels(pool),
  ]);

  const row = summaryRes.rows[0];
  const openReviewCount = Number(row?.open_review_count ?? 0);
  const highOpenCount = Number(row?.high_open_count ?? 0);
  const reconciliationSignalCount = Number(row?.reconciliation_signal_count ?? 0);
  const externalPendingCount = Number(row?.external_pending_count ?? 0);
  const missingAmountCount = Number(row?.missing_amount_count ?? 0);
  const staleProductionRateCount = capacityModels.filter(
    (c) => (c as unknown as { isStaleRate?: boolean }).isStaleRate,
  ).length;
  const decisionConfidence = decisionConfidenceScore({
    openReviewCount,
    highOpenCount,
    reconciliationSignalCount,
    missingAmountCount,
    staleProductionRateCount,
    externalPendingCount,
  });

  return {
    decisionConfidence,
    decisionConfidenceLabel: decisionConfidenceLabel(decisionConfidence),
    workbookVersions:
      row?.wb_id && row.wb_filename && row.wb_imported_at && row.wb_status
        ? [
            {
              id: row.wb_id,
              original_filename: row.wb_filename,
              imported_at: row.wb_imported_at,
              status: row.wb_status,
            },
          ]
        : [],
  };
}

export async function loadDataQualityCenter(pool: Pool | PoolClient) {
  return withPinnedRead(pool, loadDataQualityCenterInner);
}

async function loadDataQualityCenterInner(pool: Pool | PoolClient) {
  const [reviewCounts, issueCounts, openReviews, actions, specialSheets, scalarSignals, workbookVersions, workbookStats, changedSheets, cashflowReconciliation, auditTrail, capacityModels] = await gather(pool, [
    () => pool.query<{ status: string; severity: DqSeverity; n: number }>(
      `select status, severity, count(*)::int n
       from public.mapping_reviews group by status, severity`,
    ),
    () => pool.query<{ issue_type: string; n: number; open_n: number }>(
      `select issue_type, count(*)::int n,
              count(*) filter (where status in ('open','rejected'))::int open_n
       from public.mapping_reviews group by issue_type order by open_n desc, n desc, issue_type limit 12`,
    ),
    () => pool.query<DataQualityBlocker>(
      `select m.id, m.workbook_id, w.original_filename as workbook_name, m.sheet_id,
              m.issue_type, m.severity, m.message, m.status, m.created_at,
              s.sheet_name, r.row_index,
              case when m.sheet_id is null then '/data/imports/' || m.workbook_id::text || '/reviews'
                   else '/data/imports/' || m.workbook_id::text || '/sheets/' || m.sheet_id::text end as source_href
       from public.mapping_reviews m
       join public.source_workbooks w on w.id=m.workbook_id
       left join public.source_sheets s on s.id=m.sheet_id
       left join public.import_rows r on r.id=m.import_row_id
       where m.status in ('open','rejected')
       order by case m.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
                m.created_at asc
       limit 50`,
    ),
    () => pool.query<ActionItem>(
      `select id, title, severity, owner, to_char(due_date,'YYYY-MM-DD') as due_date, status,
              source_type, source_fact_key, source_href, related_entity_table, related_entity_id,
              note,
              to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at,
              to_char(updated_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as updated_at
       from public.action_items
       where status in ('open','in_progress','blocked')
       order by case severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
                due_date nulls last, created_at desc
       limit 50`,
    ),
    () => pool.query<{ workbook_name: string; sheet_name: string; detected_type: string | null; parse_confidence: string }>(
      `select w.original_filename as workbook_name, s.sheet_name, s.detected_type, s.parse_confidence
       from public.source_sheets s join public.source_workbooks w on w.id=s.workbook_id
       where lower(s.sheet_name) in ('01_dashboard','02_aylik ozet','02_aylik özet','00_rehber')
          or lower(s.sheet_name) like '%dashboard%'
          or lower(s.sheet_name) like '%rehber%'
          or lower(s.sheet_name) like '%aylik%ozet%'
          or lower(s.sheet_name) like '%aylık%özet%'
       order by w.imported_at desc, s.sheet_index`,
    ),
    () => pool.query<{
      external_pending: number;
      reconciliation_signals: number;
      missing_amounts: number;
    }>(
      `select
         (select count(*)::int from public.external_assumptions where review_status='pending_review') as external_pending,
         (
           select count(*)::int
           from public.mapping_reviews
           where issue_type in ('cashflow_identity_mismatch','continuity_break','month_gap')
             and status in ('open','rejected')
         ) as reconciliation_signals,
         (
           (select count(*)::int from public.payment_instances where amount is null and status in ('unpaid','partial','planned','late')) +
           (select count(*)::int from public.cashflow_lines where amount is null)
         )::int as missing_amounts`,
    ),
    () => pool.query<{ id: string; original_filename: string; imported_at: string; status: string }>(
      `select id::text, original_filename,
              to_char(imported_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as imported_at,
              status
       from public.source_workbooks
       order by imported_at desc
       limit 6`,
    ),
    () => pool.query<{
      workbook_id: string;
      original_filename: string;
      imported_at: string;
      sheet_count: number;
      row_count: number;
      cell_count: number;
      formula_count: number;
      monthly_sheet_count: number;
    }>(
      `with last2 as (
         select id, original_filename,
                to_char(imported_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as imported_at
         from public.source_workbooks
         order by imported_at desc
         limit 2
       )
       select l.id::text as workbook_id, l.original_filename, l.imported_at,
              ss.sheet_count,
              (select count(*)::int from public.import_rows r where r.workbook_id=l.id) as row_count,
              sc.cell_count,
              sc.formula_count,
              ss.monthly_sheet_count
       from last2 l
       cross join lateral (
         select count(*)::int as sheet_count,
                count(*) filter (where s.detected_type='monthly_cashflow')::int as monthly_sheet_count
         from public.source_sheets s
         where s.workbook_id = l.id
       ) ss
       cross join lateral (
         select count(*)::int as cell_count,
                count(*) filter (where c.formula is not null and c.formula <> '')::int as formula_count
         from public.source_cells c
         where c.workbook_id = l.id
       ) sc
       order by l.imported_at desc`,
    ),
    () => pool.query<{ sheet_name: string; side: string }>(
      `with last2 as (
         select id, row_number() over(order by imported_at desc) as rn
         from public.source_workbooks
         order by imported_at desc
         limit 2
       ),
       a as (select lower(sheet_name) as sheet_name from public.source_sheets where workbook_id=(select id from last2 where rn=1)),
       b as (select lower(sheet_name) as sheet_name from public.source_sheets where workbook_id=(select id from last2 where rn=2))
       select coalesce(a.sheet_name,b.sheet_name) as sheet_name,
              case when a.sheet_name is null then 'only_B'
                   when b.sheet_name is null then 'only_A'
                   else 'both' end as side
       from a full outer join b using(sheet_name)
       where a.sheet_name is null or b.sheet_name is null
       order by 1
       limit 20`,
    ),
    () => pool.query<{
      month_start: string;
      app_opening: number | null;
      source_opening: number | null;
      app_closing: number | null;
      source_closing: number | null;
      opening_diff: number | null;
      closing_diff: number | null;
    }>(
      // Faz 17 / Faz 41 (B3-04): Parse `source_cells.normalized_value` without 100x decimal stripping!
      // Standard JS decimal (`"123456.78"`) casts directly to `numeric`; Turkish formatted strings
      // (`"123.456,78"` or `"123.456"`) strip thousands dots and convert comma to dot; non-numeric
      // or formula-error strings yield NULL cleanly without 22P02 crashes.
      `with parsed_cells as (
         select cm.month_start,
                cm.opening_balance as app_opening,
                cm.closing_balance as app_closing,
                case
                  when b1.normalized_value is null or b1.inferred_type = 'error' then null
                  when btrim(b1.normalized_value) ~ '^-?[0-9]+(\\.[0-9]+)?$'
                    then btrim(b1.normalized_value)::numeric
                  when btrim(b1.normalized_value) ~ '^-?[0-9]{1,3}(\\.[0-9]{3})*(,[0-9]+)?$'
                    then replace(replace(btrim(b1.normalized_value), '.', ''), ',', '.')::numeric
                  when btrim(b1.normalized_value) ~ '^-?[0-9]+,[0-9]+$'
                    then replace(btrim(b1.normalized_value), ',', '.')::numeric
                  else null
                end as source_opening,
                case
                  when j1.normalized_value is null or j1.inferred_type = 'error' then null
                  when btrim(j1.normalized_value) ~ '^-?[0-9]+(\\.[0-9]+)?$'
                    then btrim(j1.normalized_value)::numeric
                  when btrim(j1.normalized_value) ~ '^-?[0-9]{1,3}(\\.[0-9]{3})*(,[0-9]+)?$'
                    then replace(replace(btrim(j1.normalized_value), '.', ''), ',', '.')::numeric
                  when btrim(j1.normalized_value) ~ '^-?[0-9]+,[0-9]+$'
                    then replace(btrim(j1.normalized_value), ',', '.')::numeric
                  else null
                end as source_closing
         from public.cashflow_months cm
         left join public.source_cells b1 on b1.sheet_id = cm.source_sheet_id and b1.address in ('B1', 'b1')
         left join public.source_cells j1 on j1.sheet_id = cm.source_sheet_id and j1.address in ('J1', 'j1')
       )
       select to_char(month_start, 'YYYY-MM-DD') as month_start,
              app_opening,
              source_opening,
              app_closing,
              source_closing,
              case
                when source_opening is null or app_opening is null then null
                else app_opening - source_opening
              end as opening_diff,
              case
                when source_closing is null or app_closing is null then null
                else app_closing - source_closing
              end as closing_diff
       from parsed_cells
       order by month_start desc
       limit 24`,
    ),
    () => pool.query<AuditTrailItem>(
      `select action, entity_table, entity_id::text,
              to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
       from public.audit_logs
       where entity_table in ('source_workbooks','mapping_reviews','action_items','ai_response_snapshots','reports','scenario_runs')
       order by created_at desc
       limit 8`,
    ),
    () => loadCapacityModels(pool),
  ]);

  const scalarRow = scalarSignals.rows[0];
  const blockers = rankReviewSignals(openReviews.rows, 5);
  const openReviewCount = reviewCounts.rows
    .filter((r) => r.status === "open" || r.status === "rejected")
    .reduce((sum, r) => sum + r.n, 0);
  const highOpenCount = reviewCounts.rows
    .filter((r) => (r.status === "open" || r.status === "rejected") && (r.severity === "critical" || r.severity === "high"))
    .reduce((sum, r) => sum + r.n, 0);
  const staleProductionRateCount = capacityModels.filter((c) => (c as unknown as { isStaleRate?: boolean }).isStaleRate).length;
  const missingAmountCount = Number(scalarRow?.missing_amounts ?? 0);
  const reconciliationSignalCount = Number(scalarRow?.reconciliation_signals ?? 0);
  const externalPendingCount = Number(scalarRow?.external_pending ?? 0);
  const decisionConfidence = decisionConfidenceScore({
    openReviewCount,
    highOpenCount,
    reconciliationSignalCount,
    missingAmountCount,
    staleProductionRateCount,
    externalPendingCount,
  });
  const workbookChangedSheets = changedSheets.rows.map((s) => {
    const c = classifyWorkbookChange(s.sheet_name);
    return { ...s, area: c.area, impact: c.impact as WorkbookChangeImpact };
  });

  return {
    openReviewCount,
    highOpenCount,
    actionOpenCount: actions.rows.length,
    externalPendingCount,
    missingAmountCount,
    staleProductionRateCount,
    decisionConfidence,
    decisionConfidenceLabel: decisionConfidenceLabel(decisionConfidence),
    reviewCounts: reviewCounts.rows,
    issueCounts: issueCounts.rows,
    blockers,
    actions: actions.rows.map((a) => ({
      ...a,
      source_href: a.source_href ? safeRedirectPath(a.source_href, "/data/quality") : null,
    })),
    specialSheets: specialSheets.rows,
    workbookVersions: workbookVersions.rows,
    reconciliationSignalCount,
    workbookDiff: {
      ready: workbookStats.rows.length >= 2,
      a: workbookStats.rows[0] ?? null,
      b: workbookStats.rows[1] ?? null,
      changedSheets: workbookChangedSheets,
    },
    // Five numeric columns, decoded once. The two *_diff values are what the UI thresholds
    // against, so they must be the exact difference Postgres computed.
    cashflowReconciliation: cashflowReconciliation.rows.map((r) => ({
      ...r,
      app_opening: moneyOrNull(r.app_opening), source_opening: moneyOrNull(r.source_opening),
      app_closing: moneyOrNull(r.app_closing), source_closing: moneyOrNull(r.source_closing),
      opening_diff: moneyOrNull(r.opening_diff), closing_diff: moneyOrNull(r.closing_diff),
    })),
    auditTrail: auditTrail.rows,
  };
}

function dueIn(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function createActionFromReview(pool: Pool, reviewId: string, actorId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: string }>(
      `select id from public.action_items
       where source_type='mapping_review'
         and related_entity_table='mapping_reviews'
         and related_entity_id=$1
         and status in ('open','in_progress','blocked')
       limit 1`,
      [reviewId],
    );
    if (existing.rows[0]) {
      await client.query("commit");
      return existing.rows[0].id;
    }

    const review = await client.query<DataQualityBlocker>(
      `select m.id, m.workbook_id, w.original_filename as workbook_name, m.sheet_id,
              m.issue_type, m.severity, m.message, m.status, m.created_at,
              s.sheet_name, r.row_index,
              '/data/imports/' || m.workbook_id::text || '/reviews?status=' || m.status as source_href
       from public.mapping_reviews m
       join public.source_workbooks w on w.id=m.workbook_id
       left join public.source_sheets s on s.id=m.sheet_id
       left join public.import_rows r on r.id=m.import_row_id
       where m.id=$1 for update of m`,
      [reviewId],
    );
    const r = review.rows[0];
    if (!r) {
      await client.query("commit");
      return null;
    }
    const safeHref = safeRedirectPath(r.source_href, "/data/reviews");
    const ins = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, severity, due_date, status, source_type, source_href,
          related_entity_table, related_entity_id, note, created_by)
       values ($1,$2,$3,'open','mapping_review',$4,'mapping_reviews',$5,$6,$7)
       returning id`,
      [reviewActionTitle(r), r.severity, dueIn(r.severity === "critical" || r.severity === "high" ? 1 : 3), safeHref, r.id, r.message, actorId],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Görev kaydı oluşturulamadı.");
    }
    const id = ins.rows[0].id;
    await audit(client, {
      actor: actorId, action: "create_action_from_review", entityTable: "action_items", entityId: id,
      before: null, after: { reviewId, title: reviewActionTitle(r) },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function createActionFromHomeSignal(
  pool: Pool,
  input: { title: string; severity: DqSeverity; sourceFactKey: string; sourceHref: string; note?: string | null },
  actorId: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: string }>(
      `select id from public.action_items
       where source_type='home_action' and source_fact_key=$1 and status in ('open','in_progress','blocked')
       limit 1`,
      [input.sourceFactKey],
    );
    if (existing.rows[0]) {
      await client.query("commit");
      return existing.rows[0].id;
    }
    const safeHref = safeRedirectPath(input.sourceHref, "/overview");
    const ins = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, severity, due_date, status, source_type, source_fact_key, source_href, note, created_by)
       values ($1,$2,$3,'open','home_action',$4,$5,$6,$7) returning id`,
      [input.title, input.severity, dueIn(input.severity === "critical" || input.severity === "high" ? 1 : 7), input.sourceFactKey, safeHref, input.note ?? null, actorId],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Görev kaydı oluşturulamadı.");
    }
    const id = ins.rows[0].id;
    await audit(client, {
      actor: actorId, action: "create_action_from_home", entityTable: "action_items", entityId: id,
      before: null, after: { ...input, sourceHref: safeHref },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function createActionFromAiResponse(pool: Pool, aiResponseId: string, actorId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: string }>(
      `select id from public.action_items
       where source_type='ai_response'
        and related_entity_table='ai_response_snapshots'
        and related_entity_id=$1
        and status in ('open','in_progress','blocked')
       limit 1`,
      [aiResponseId],
    );
    if (existing.rows[0]) {
      await client.query("commit");
      return existing.rows[0].id;
    }
    const ai = await client.query<{
      id: string;
      question: string;
      answer_md: string;
      report_id: string | null;
      source_hrefs: string[];
    }>(
      `select id, question, answer_md, report_id, source_hrefs
       from public.ai_response_snapshots where id=$1 for update`,
      [aiResponseId],
    );
    const r = ai.rows[0];
    if (!r) {
      await client.query("commit");
      return null;
    }
    const sourceHref = r.report_id ? `/insights/reports/${r.report_id}?ai=${r.id}` : `/insights/ask/${r.id}`;
    const ins = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, severity, due_date, status, source_type, source_href,
          related_entity_table, related_entity_id, note, created_by)
       values ($1,'medium',$2,'open','ai_response',$3,'ai_response_snapshots',$4,$5,$6)
       returning id`,
      [
        `AI cevap aksiyonu: ${r.question.slice(0, 160)}`,
        dueIn(3),
        sourceHref,
        r.id,
        r.answer_md.slice(0, 1000),
        actorId,
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Görev kaydı oluşturulamadı.");
    }
    const id = ins.rows[0].id;
    await audit(client, {
      actor: actorId, action: "create_action_from_ai_response", entityTable: "action_items", entityId: id,
      before: null, after: { aiResponseId, sourceHref },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function createActionFromReport(pool: Pool, reportId: string, actorId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: string }>(
      `select id from public.action_items
       where source_type='report'
         and related_entity_table='reports'
         and related_entity_id=$1
         and status in ('open','in_progress','blocked')
       limit 1`,
      [reportId],
    );
    if (existing.rows[0]) {
      await client.query("commit");
      return existing.rows[0].id;
    }
    const report = await client.query<{
      id: string;
      report_type: string;
      period_start: string;
      period_end: string;
      body_md: string;
    }>(
      `select id, report_type, to_char(period_start,'YYYY-MM-DD') as period_start,
              to_char(period_end,'YYYY-MM-DD') as period_end, body_md
       from public.reports where id=$1 for update`,
      [reportId],
    );
    const r = report.rows[0];
    if (!r) {
      await client.query("commit");
      return null;
    }
    const sourceHref = `/insights/reports/${r.id}`;
    const ins = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, severity, due_date, status, source_type, source_href,
          related_entity_table, related_entity_id, note, created_by)
       values ($1,'medium',$2,'open','report',$3,'reports',$4,$5,$6)
       returning id`,
      [
        `Rapor aksiyonu: ${r.report_type} ${r.period_start}`,
        dueIn(3),
        sourceHref,
        r.id,
        r.body_md.slice(0, 1000),
        actorId,
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Görev kaydı oluşturulamadı.");
    }
    const id = ins.rows[0].id;
    await audit(client, {
      actor: actorId, action: "create_action_from_report", entityTable: "action_items", entityId: id,
      before: null, after: { reportId, sourceHref },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function createManualAction(
  pool: Pool,
  input: {
    title: string;
    severity: DqSeverity;
    owner?: string | null;
    ownerUserId?: string | null;
    autoCloseOnSettlement?: boolean;
    dueDate?: string | null;
    note?: string | null;
    relatedEntityTable?: string | null;
    relatedEntityId?: string | null;
  },
  actorId: string,
): Promise<string | null> {
  const title = input.title.trim().slice(0, 240);
  if (!title) return null;
  const ownerUserId = input.ownerUserId && /^[0-9a-f-]{36}$/i.test(input.ownerUserId.trim())
    ? input.ownerUserId.trim()
    : null;
  const relatedEntityId = input.relatedEntityId && /^[0-9a-f-]{36}$/i.test(input.relatedEntityId.trim())
    ? input.relatedEntityId.trim()
    : null;
  const relatedEntityTable = relatedEntityId && input.relatedEntityTable?.trim()
    ? input.relatedEntityTable.trim()
    : null;
  const autoClose = input.autoCloseOnSettlement !== false;

  const client = await pool.connect();
  try {
    await client.query("begin");
    let resolvedOwner = input.owner?.trim() || null;
    if (ownerUserId && !resolvedOwner) {
      const lbl = await client.query<{ label: string | null }>(
        `select public.user_display_label($1::uuid) as label`,
        [ownerUserId],
      );
      resolvedOwner = lbl.rows[0]?.label?.trim() || null;
    }

    const ins = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, severity, owner, owner_user_id, auto_close_on_settlement, due_date, status, source_type,
          related_entity_table, related_entity_id, note, created_by)
       values ($1,$2,$3,$4::uuid,$5,$6,'open','manual',$7,$8::uuid,$9,$10) returning id`,
      [
        title,
        input.severity,
        resolvedOwner,
        ownerUserId,
        autoClose,
        input.dueDate || null,
        relatedEntityTable,
        relatedEntityId,
        input.note ?? null,
        actorId,
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Görev kaydı oluşturulamadı.");
    }
    const id = ins.rows[0].id;
    await audit(client, {
      actor: actorId, action: "create_manual_action", entityTable: "action_items", entityId: id,
      before: null, after: { ...input, owner: resolvedOwner, ownerUserId, autoCloseOnSettlement: autoClose },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function setActionStatus(pool: Pool, id: string, status: ActionStatus, actorId: string, completionNote?: string | null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(`select id, status, note from public.action_items where id=$1 for update`, [id]);
    if (before.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Görev kaydı bulunamadı veya yetkiniz yok.");
    }
    const note = completionNote?.trim()
      ? `Kapanis notu (${new Date().toISOString().slice(0, 10)}): ${completionNote.trim().slice(0, 500)}`
      : null;
    const upd = await client.query(
      `update public.action_items
       set status=$2,
           note=case
             when $3::text is null then note
             when note is null or note='' then $3
             else note || E'\n\n' || $3
           end
       where id=$1`,
      [id, status, note],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Görev kaydı güncellenemedi veya yetkiniz yok.");
    }
    await audit(client, {
      actor: actorId, action: "set_action_status", entityTable: "action_items", entityId: id,
      before: before.rows[0], after: { id, status, completionNote: note },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
