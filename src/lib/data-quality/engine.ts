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
  const [reviewCounts, issueCounts, openReviews, actions, specialSheets] = await Promise.all([
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
    reviewCounts: reviewCounts.rows,
    issueCounts: issueCounts.rows,
    blockers,
    actions: actions.rows,
    specialSheets: specialSheets.rows,
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
