import { AuditTable, type AuditRow } from "@/components/system/audit-table";
import { PaginationBar, parsePageParam } from "@/components/ui/pagination-bar";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { getPool, withReadConnection } from "@/lib/db";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  searchParams,
}: {
  searchParams?: Promise<{ page?: string }>;
}) {
  const denied = await requireRouteAccess("/system/audit");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const { page, limit, offset } = parsePageParam(sp.page, 50);

  const { rows, totalCount } = await withReadConnection(getPool(), async (db) => {
    const [countRes, listRes] = await Promise.all([
      db.query<{ total: number }>(`select count(*)::int as total from public.audit_logs`),
      db.query(
        `select id::text, action, entity_table, entity_id::text,
                to_char(created_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as created_at,
                before_data, after_data
         from public.audit_logs
         order by created_at desc, id desc
         limit $1 offset $2`,
        [limit, offset],
      ),
    ]);
    return {
      totalCount: Number(countRes.rows[0]?.total ?? 0),
      rows: listRes.rows.map((x) => ({
        id: x.id,
        action: x.action,
        entity: `${x.entity_table} · ${x.entity_id}`,
        created_at: x.created_at,
        before: x.before_data == null ? "—" : JSON.stringify(x.before_data),
        after: x.after_data == null ? "—" : JSON.stringify(x.after_data),
      })) as AuditRow[],
    };
  });

  return (
    <>
      <PageHeader
        title="Denetim Kayıtları"
        subtitle="Değişikliklerin önce/sonra geçmişi ve kaynak izlenebilirliği"
      />
      <Panel title={`Denetim Kayıtları (${totalCount} toplam)`}>
        <AuditTable rows={rows} />
        <PaginationBar
          basePath="/system/audit"
          page={page}
          pageSize={limit}
          totalCount={totalCount}
        />
      </Panel>
    </>
  );
}
