import type { Pool, PoolClient } from "pg";
import { rankReviewSignals, reviewActionTitle, type ActionStatus, type DqSeverity, type ReviewSignal } from "./rules";

async function audit(client: PoolClient, action: string, entityId: string | null, before: unknown, after: unknown): Promise<void> {
  await client.query(
    `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
     values (null,$1,'action_items',$2,$3,$4)`,
    [action, entityId, JSON.stringify(before ?? null), JSON.stringify(after ?? null)],
  );
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

export interface DataQualityBlocker extends ReviewSignal {
  workbook_id: string;
  workbook_name: string;
  sheet_id: string | null;
  source_href: string;
}

export async function loadDataQualityCenter(pool: Pool) {
  const [reviewCounts, issueCounts, openReviews, actions, specialSheets, externalPending, workbookVersions, reconciliationSignals, workbookStats, changedSheets, cashflowReconciliation] = await Promise.all([
    pool.query<{ status: string; severity: DqSeverity; n: number }>(
      `select status, severity, count(*)::int n
       from public.mapping_reviews group by status, severity`,
    ),
    pool.query<{ issue_type: string; n: number; open_n: number }>(
      `select issue_type, count(*)::int n,
              count(*) filter (where status in ('open','rejected'))::int open_n
       from public.mapping_reviews group by issue_type order by open_n desc, n desc, issue_type limit 12`,
    ),
    pool.query<DataQualityBlocker>(
      `select m.id, m.workbook_id, w.original_filename as workbook_name, m.sheet_id,
              m.issue_type, m.severity, m.message, m.status, m.created_at,
              s.sheet_name, r.row_index,
              case when m.sheet_id is null then '/imports/' || m.workbook_id::text || '/reviews'
                   else '/imports/' || m.workbook_id::text || '/sheets/' || m.sheet_id::text end as source_href
       from public.mapping_reviews m
       join public.source_workbooks w on w.id=m.workbook_id
       left join public.source_sheets s on s.id=m.sheet_id
       left join public.import_rows r on r.id=m.import_row_id
       where m.status in ('open','rejected')
       order by case m.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
                m.created_at asc
       limit 50`,
    ),
    pool.query<ActionItem>(
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
    pool.query<{ workbook_name: string; sheet_name: string; detected_type: string | null; parse_confidence: string }>(
      `select w.original_filename as workbook_name, s.sheet_name, s.detected_type, s.parse_confidence
       from public.source_sheets s join public.source_workbooks w on w.id=s.workbook_id
       where lower(s.sheet_name) in ('01_dashboard','02_aylik ozet','02_aylik özet','00_rehber')
          or lower(s.sheet_name) like '%dashboard%'
          or lower(s.sheet_name) like '%rehber%'
          or lower(s.sheet_name) like '%aylik%ozet%'
          or lower(s.sheet_name) like '%aylık%özet%'
       order by w.imported_at desc, s.sheet_index`,
    ),
    pool.query<{ n: number }>(
      `select count(*)::int n from public.external_assumptions where review_status='pending_review'`,
    ),
    pool.query<{ id: string; original_filename: string; imported_at: string; status: string }>(
      `select id::text, original_filename,
              to_char(imported_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as imported_at,
              status
       from public.source_workbooks
       order by imported_at desc
       limit 6`,
    ),
    pool.query<{ n: number }>(
      `select count(*)::int n
       from public.mapping_reviews
       where issue_type in ('cashflow_identity_mismatch','continuity_break','month_gap')
         and status in ('open','rejected')`,
    ),
    pool.query<{
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
              (select count(*)::int from public.source_sheets s where s.workbook_id=l.id) as sheet_count,
              (select count(*)::int from public.import_rows r where r.workbook_id=l.id) as row_count,
              (select count(*)::int from public.source_cells c where c.workbook_id=l.id) as cell_count,
              (select count(*)::int from public.source_cells c where c.workbook_id=l.id and c.formula is not null and c.formula <> '') as formula_count,
              (select count(*)::int from public.source_sheets s where s.workbook_id=l.id and s.detected_type='monthly_cashflow') as monthly_sheet_count
       from last2 l
       order by l.imported_at desc`,
    ),
    pool.query<{ sheet_name: string; side: string }>(
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
    pool.query<{
      month_start: string;
      app_opening: number | null;
      source_opening: number | null;
      app_closing: number | null;
      source_closing: number | null;
      opening_diff: number | null;
      closing_diff: number | null;
    }>(
      `select to_char(cm.month_start,'YYYY-MM-DD') as month_start,
              cm.opening_balance::float8 as app_opening,
              case
                when b1.normalized_value is null then null
                else nullif(regexp_replace(replace(replace(b1.normalized_value,'.',''),',','.'),'[^0-9\\.-]','','g'),'')::float8
              end as source_opening,
              cm.closing_balance::float8 as app_closing,
              case
                when j1.normalized_value is null then null
                else nullif(regexp_replace(replace(replace(j1.normalized_value,'.',''),',','.'),'[^0-9\\.-]','','g'),'')::float8
              end as source_closing,
              case
                when b1.normalized_value is null or cm.opening_balance is null then null
                else cm.opening_balance::float8 - nullif(regexp_replace(replace(replace(b1.normalized_value,'.',''),',','.'),'[^0-9\\.-]','','g'),'')::float8
              end as opening_diff,
              case
                when j1.normalized_value is null or cm.closing_balance is null then null
                else cm.closing_balance::float8 - nullif(regexp_replace(replace(replace(j1.normalized_value,'.',''),',','.'),'[^0-9\\.-]','','g'),'')::float8
              end as closing_diff
       from public.cashflow_months cm
       left join public.source_cells b1 on b1.sheet_id=cm.source_sheet_id and upper(b1.address)='B1'
       left join public.source_cells j1 on j1.sheet_id=cm.source_sheet_id and upper(j1.address)='J1'
       order by cm.month_start desc
       limit 24`,
    ),
  ]);

  const blockers = rankReviewSignals(openReviews.rows, 5);
  const openReviewCount = reviewCounts.rows
    .filter((r) => r.status === "open" || r.status === "rejected")
    .reduce((sum, r) => sum + r.n, 0);
  const highOpenCount = reviewCounts.rows
    .filter((r) => (r.status === "open" || r.status === "rejected") && (r.severity === "critical" || r.severity === "high"))
    .reduce((sum, r) => sum + r.n, 0);

  return {
    openReviewCount,
    highOpenCount,
    actionOpenCount: actions.rows.length,
    externalPendingCount: Number(externalPending.rows[0]?.n ?? 0),
    reviewCounts: reviewCounts.rows,
    issueCounts: issueCounts.rows,
    blockers,
    actions: actions.rows,
    specialSheets: specialSheets.rows,
    workbookVersions: workbookVersions.rows,
    reconciliationSignalCount: Number(reconciliationSignals.rows[0]?.n ?? 0),
    workbookDiff: {
      ready: workbookStats.rows.length >= 2,
      a: workbookStats.rows[0] ?? null,
      b: workbookStats.rows[1] ?? null,
      changedSheets: changedSheets.rows,
    },
    cashflowReconciliation: cashflowReconciliation.rows,
  };
}

function dueIn(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function createActionFromReview(pool: Pool, reviewId: string): Promise<string | null> {
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
              '/imports/' || m.workbook_id::text || '/reviews?status=' || m.status as source_href
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
    const ins = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, severity, due_date, status, source_type, source_href,
          related_entity_table, related_entity_id, note)
       values ($1,$2,$3,'open','mapping_review',$4,'mapping_reviews',$5,$6)
       returning id`,
      [reviewActionTitle(r), r.severity, dueIn(r.severity === "critical" || r.severity === "high" ? 1 : 3), r.source_href, r.id, r.message],
    );
    const id = ins.rows[0].id;
    await audit(client, "create_action_from_review", id, null, { reviewId, title: reviewActionTitle(r) });
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
    const ins = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, severity, due_date, status, source_type, source_fact_key, source_href, note)
       values ($1,$2,$3,'open','home_action',$4,$5,$6) returning id`,
      [input.title, input.severity, dueIn(input.severity === "critical" || input.severity === "high" ? 1 : 7), input.sourceFactKey, input.sourceHref, input.note ?? null],
    );
    const id = ins.rows[0].id;
    await audit(client, "create_action_from_home", id, null, input);
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function createActionFromAiResponse(pool: Pool, aiResponseId: string): Promise<string | null> {
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
    const sourceHref = r.report_id ? `/reports/${r.report_id}?ai=${r.id}` : `/ask?response=${r.id}`;
    const ins = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, severity, due_date, status, source_type, source_href,
          related_entity_table, related_entity_id, note)
       values ($1,'medium',$2,'open','ai_response',$3,'ai_response_snapshots',$4,$5)
       returning id`,
      [
        `AI cevap aksiyonu: ${r.question.slice(0, 160)}`,
        dueIn(3),
        sourceHref,
        r.id,
        r.answer_md.slice(0, 1000),
      ],
    );
    const id = ins.rows[0].id;
    await audit(client, "create_action_from_ai_response", id, null, { aiResponseId, sourceHref });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function createActionFromReport(pool: Pool, reportId: string): Promise<string | null> {
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
    const sourceHref = `/reports/${r.id}`;
    const ins = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, severity, due_date, status, source_type, source_href,
          related_entity_table, related_entity_id, note)
       values ($1,'medium',$2,'open','report',$3,'reports',$4,$5)
       returning id`,
      [
        `Rapor aksiyonu: ${r.report_type} ${r.period_start}`,
        dueIn(3),
        sourceHref,
        r.id,
        r.body_md.slice(0, 1000),
      ],
    );
    const id = ins.rows[0].id;
    await audit(client, "create_action_from_report", id, null, { reportId, sourceHref });
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
  input: { title: string; severity: DqSeverity; owner?: string | null; dueDate?: string | null; note?: string | null },
): Promise<string | null> {
  const title = input.title.trim().slice(0, 240);
  if (!title) return null;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query<{ id: string }>(
      `insert into public.action_items (title, severity, owner, due_date, status, source_type, note)
       values ($1,$2,$3,$4,'open','manual',$5) returning id`,
      [title, input.severity, input.owner ?? null, input.dueDate || null, input.note ?? null],
    );
    const id = ins.rows[0].id;
    await audit(client, "create_manual_action", id, null, input);
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function setActionStatus(pool: Pool, id: string, status: ActionStatus): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(`select id, status from public.action_items where id=$1 for update`, [id]);
    if (before.rowCount === 1) {
      await client.query(`update public.action_items set status=$2 where id=$1`, [id, status]);
      await audit(client, "set_action_status", id, before.rows[0], { id, status });
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
