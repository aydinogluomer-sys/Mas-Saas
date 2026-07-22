import { getPool } from "@/lib/db";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { AuditTable, type AuditRow } from "@/components/system/audit-table";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const r = await getPool().query(`select id::text,action,entity_table,entity_id::text,to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') created_at,before_data,after_data from audit_logs order by created_at desc limit 200`);
  const rows: AuditRow[] = r.rows.map((x) => ({
    id: x.id,
    action: x.action,
    entity: `${x.entity_table} · ${x.entity_id}`,
    created_at: x.created_at,
    before: x.before_data == null ? "—" : JSON.stringify(x.before_data),
    after: x.after_data == null ? "—" : JSON.stringify(x.after_data),
  }));
  return (
    <>
      <PageHeader title="Denetim Kayıtları" subtitle="Değişikliklerin önce/sonra geçmişi ve kaynak izlenebilirliği" />
      <Panel title={`Son ${rows.length} kayıt`}>
        <AuditTable rows={rows} />
      </Panel>
    </>
  );
}
