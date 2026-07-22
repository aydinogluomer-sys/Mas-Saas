import type { Pool, PoolClient } from "pg";

export type ArchiveEntity =
  | "payments"
  | "checks"
  | "loans"
  | "scenario_runs"
  | "external_assumptions"
  | "action_items";

const ALLOWED = new Set<ArchiveEntity>([
  "payments",
  "checks",
  "loans",
  "scenario_runs",
  "external_assumptions",
  "action_items",
]);

export interface ArchiveRecord {
  entityTable: ArchiveEntity;
  id: string;
  label: string;
  archivedAt: string;
  reason: string | null;
  sourceLinked: boolean;
  restoreHref: string;
}

const assertEntity = (entity: string): ArchiveEntity => {
  if (!ALLOWED.has(entity as ArchiveEntity)) throw new Error("Desteklenmeyen arşiv türü");
  return entity as ArchiveEntity;
};

const audit = (
  client: PoolClient,
  action: string,
  table: string,
  id: string,
  before: unknown,
  after: unknown,
) =>
  client.query(
    `insert into public.audit_logs(actor,action,entity_table,entity_id,before_data,after_data)
     values(null,$1,$2,$3,$4,$5)`,
    [action, table, id, JSON.stringify(before), JSON.stringify(after)],
  );

export async function archiveRecord(
  pool: Pool,
  entityRaw: string,
  id: string,
  reason: string,
  actor = "Yerel kullanıcı",
) {
  const entity = assertEntity(entityRaw);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(`select * from public.${entity} where id=$1 for update`, [id]);
    if (before.rowCount !== 1) throw new Error("Kayıt bulunamadı");
    await client.query(
      `update public.${entity}
       set archived_at=now(),archive_reason=$2,archived_by_label=$3${entity === "payments" ? ",status='archived'" : ""}
       where id=$1`,
      [id, reason || null, actor],
    );
    await audit(client, "archive_record", entity, id, before.rows[0], { archived: true, reason, actor });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function restoreRecord(pool: Pool, entityRaw: string, id: string) {
  const entity = assertEntity(entityRaw);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(`select * from public.${entity} where id=$1 for update`, [id]);
    if (before.rowCount !== 1) throw new Error("Kayıt bulunamadı");
    await client.query(
      `update public.${entity}
       set archived_at=null,archive_reason=null,archived_by_label=null${entity === "payments" ? ",status='active'" : ""}
       where id=$1`,
      [id],
    );
    await audit(client, "restore_record", entity, id, before.rows[0], { archived: false });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const archiveQueries: Record<ArchiveEntity, string> = {
  payments: `select 'payments' entity_table,id,name label,archived_at,archive_reason,
    (source_row_id is not null) source_linked,'/payments/archive' restore_href
    from public.payments where archived_at is not null`,
  checks: `select 'checks' entity_table,id,coalesce(counterparty_label,serial_no,'Çek') label,
    archived_at,archive_reason,(source_row_id is not null) source_linked,'/finance/archive' restore_href
    from public.checks where archived_at is not null`,
  loans: `select 'loans' entity_table,id,name label,archived_at,archive_reason,
    (source_workbook_id is not null) source_linked,'/finance/archive' restore_href
    from public.loans where archived_at is not null`,
  scenario_runs: `select 'scenario_runs' entity_table,r.id,s.name label,r.archived_at,r.archive_reason,
    false source_linked,'/scenarios/history' restore_href
    from public.scenario_runs r join public.scenarios s on s.id=r.scenario_id
    where r.archived_at is not null`,
  external_assumptions: `select 'external_assumptions' entity_table,id,label,archived_at,archive_reason,
    false source_linked,'/data/assumptions' restore_href
    from public.external_assumptions where archived_at is not null`,
  action_items: `select 'action_items' entity_table,id,title label,archived_at,archive_reason,
    false source_linked,'/insights/tasks' restore_href
    from public.action_items where archived_at is not null`,
};

export async function listArchive(
  pool: Pool,
  entity?: ArchiveEntity,
  search = "",
): Promise<ArchiveRecord[]> {
  // Module archives query only their own table. A schema issue in an unrelated
  // module can therefore no longer break the Payments archive screen.
  const selected = entity ? [archiveQueries[entity]] : Object.values(archiveQueries);
  const result = await pool.query(
    `select entity_table,id,label,to_char(archived_at,'YYYY-MM-DD HH24:MI') archived_at,
       archive_reason,source_linked,restore_href
     from (${selected.join(" union all ")}) archive_rows
     where ($1='' or label ilike '%'||$1||'%')
     order by archived_at desc`,
    [search],
  );
  return result.rows.map((row) => ({
    entityTable: row.entity_table,
    id: row.id,
    label: row.label,
    archivedAt: row.archived_at,
    reason: row.archive_reason,
    sourceLinked: row.source_linked,
    restoreHref: row.restore_href,
  }));
}
