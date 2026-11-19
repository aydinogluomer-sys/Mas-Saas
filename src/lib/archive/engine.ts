import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";

export type ArchiveEntity =
  | "payments"
  | "checks"
  | "loans"
  | "invoices"
  | "credit_facilities"
  | "parties"
  | "cash_accounts"
  | "documents"
  | "scenario_runs"
  | "external_assumptions"
  | "action_items";

const ALLOWED = new Set<ArchiveEntity>([
  "payments",
  "checks",
  "loans",
  "invoices",
  "credit_facilities",
  "parties",
  "cash_accounts",
  "documents",
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
  if (!ALLOWED.has(entity as ArchiveEntity)) throw new DomainError("VALIDATION_ERROR", "Desteklenmeyen arşiv türü.");
  return entity as ArchiveEntity;
};

export async function archiveRecord(
  pool: Pool,
  entityRaw: string,
  id: string,
  reason: string,
  actorId: string,
  actorDisplayName: string,
) {
  const entity = assertEntity(entityRaw);
  const effectiveReason = reason?.trim() || "Arşivlendi";
  const effectiveActor = actorDisplayName?.trim() || "Sistem";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(`select * from public.${entity} where id=$1 for update`, [id]);
    if (before.rowCount !== 1) throw new DomainError("NOT_FOUND", "Kayıt bulunamadı.");
    const upd = await client.query(
      `update public.${entity}
       set archived_at=now(),archive_reason=$2,archived_by_label=$3${entity === "payments" ? ",status='archived'" : ""}
       where id=$1`,
      [id, effectiveReason, effectiveActor],
    );
    if (upd.rowCount !== 1) throw new DomainError("FORBIDDEN", "Kayıt arşivlenemedi veya yetkiniz yok.");

    let cancelledFutureInstances = 0;
    if (entity === "payments") {
      const cancelRes = await client.query(
        `update public.payment_instances
            set status = 'cancelled',
                cancelled_at = now(),
                cancel_reason = $2,
                paid_at = null,
                paid_amount = null
          where payment_id = $1
            and status in ('planned', 'unpaid', 'late', 'unknown')
            and due_date >= current_date`,
        [id, `Ana ödeme kalemi arşivlendi: ${effectiveReason}`],
      );
      cancelledFutureInstances = cancelRes.rowCount ?? 0;
    }

    await audit(client, {
      actor: actorId,
      action: "archive_record",
      entityTable: entity,
      entityId: id,
      before: before.rows[0],
      after: {
        archived: true,
        reason: effectiveReason,
        actor: effectiveActor,
        ...(entity === "payments" ? { cancelledFutureInstances } : {}),
      },
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function restoreRecord(pool: Pool, entityRaw: string, id: string, actorId: string) {
  const entity = assertEntity(entityRaw);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const actorRes = await client.query<{ role: string; display_name: string }>(
      `select role::text as role, display_name
         from public.users
        where id = $1 and is_active = true
        limit 1`,
      [actorId],
    );
    if (
      actorRes.rowCount === 1 &&
      actorRes.rows[0].role !== "admin" &&
      actorRes.rows[0].role !== "finance_manager"
    ) {
      throw new DomainError(
        "FORBIDDEN",
        "Arşivden geri yükleme işlemi yalnız admin veya finans müdürü tarafından yapılabilir.",
      );
    }
    const before = await client.query(`select * from public.${entity} where id=$1 for update`, [id]);
    if (before.rowCount !== 1) throw new DomainError("NOT_FOUND", "Kayıt bulunamadı.");
    await client.query("select set_config('app.allow_archive_restore', 'true', true)");
    const upd = await client.query(
      `update public.${entity}
       set archived_at=null,archive_reason=null,archived_by_label=null${entity === "payments" ? ",status='active'" : ""}
       where id=$1`,
      [id],
    );
    if (upd.rowCount !== 1) throw new DomainError("FORBIDDEN", "Kayıt geri yüklenemedi veya yetkiniz yok.");
    await audit(client, {
      actor: actorId,
      action: "restore_record",
      entityTable: entity,
      entityId: id,
      before: before.rows[0],
      after: { archived: false, controlledRestore: true },
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
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
  invoices: `select 'invoices' entity_table,id,invoice_no label,archived_at,archive_reason,
    (source_document_id is not null) source_linked,'/finance/archive' restore_href
    from public.invoices where archived_at is not null`,
  credit_facilities: `select 'credit_facilities' entity_table,id,name label,archived_at,archive_reason,
    false source_linked,'/finance/archive' restore_href
    from public.credit_facilities where archived_at is not null`,
  parties: `select 'parties' entity_table,id,name label,archived_at,archive_reason,
    false source_linked,'/finance/archive' restore_href
    from public.parties where archived_at is not null`,
  cash_accounts: `select 'cash_accounts' entity_table,id,name label,archived_at,archive_reason,
    false source_linked,'/finance/archive' restore_href
    from public.cash_accounts where archived_at is not null`,
  documents: `select 'documents' entity_table,id,title label,archived_at,archive_reason,
    false source_linked,'/system/archive' restore_href
    from public.documents where archived_at is not null`,
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
