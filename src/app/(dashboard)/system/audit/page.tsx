import Link from "@/components/ui/app-link";
import { AuditTable, type AuditRow } from "@/components/system/audit-table";
import { PaginationBar, parsePageParam } from "@/components/ui/pagination-bar";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool, withReadConnection } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  searchParams,
}: {
  searchParams?: Promise<{
    page?: string;
    entityTable?: string;
    action?: string;
    actor?: string;
  }>;
}) {
  const denied = await requireRouteAccess("/system/audit");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const { page, limit, offset } = parsePageParam(sp.page, 50);

  const entityFilter = (sp.entityTable ?? "").trim();
  const actionFilter = (sp.action ?? "").trim();
  const actorFilter = (sp.actor ?? "").trim();

  const { rows, totalCount, distinctTables } = await withReadConnection(getPool(), async (db) => {
    const usersMap = new Map<string, string>();
    const usersRes = await db
      .query<{ id: string; username: string; display_name: string }>(
        `select id::text, username, display_name from public.users`,
      )
      .catch(() => ({ rows: [] }));
    for (const u of usersRes.rows) {
      usersMap.set(u.id, `${u.display_name} (${u.username})`);
    }

    const conds: string[] = [];
    const params: unknown[] = [];
    if (entityFilter) {
      params.push(entityFilter);
      conds.push(`entity_table = $${params.length}`);
    }
    if (actionFilter) {
      params.push(`%${actionFilter}%`);
      conds.push(`action ilike $${params.length}`);
    }
    if (actorFilter) {
      const matchingIds = Array.from(usersMap.entries())
        .filter(
          ([id, label]) =>
            id.toLowerCase().includes(actorFilter.toLowerCase()) ||
            label.toLowerCase().includes(actorFilter.toLowerCase()),
        )
        .map(([id]) => id);
      if (matchingIds.length > 0) {
        params.push(matchingIds);
        conds.push(`actor::text = any($${params.length}::text[])`);
      } else {
        params.push(`%${actorFilter}%`);
        conds.push(`coalesce(actor::text, 'system') ilike $${params.length}`);
      }
    }

    const whereSql = conds.length > 0 ? `where ${conds.join(" and ")}` : "";

    const [countRes, listRes, tablesRes] = await Promise.all([
      db.query<{ total: number }>(`select count(*)::int as total from public.audit_logs ${whereSql}`, params),
      db.query<{
        id: string;
        actor: string | null;
        action: string;
        entity_table: string;
        entity_id: string | null;
        created_at: string;
        before_data: Record<string, unknown> | null;
        after_data: Record<string, unknown> | null;
      }>(
        `select id::text,
                actor::text,
                action,
                entity_table,
                entity_id::text,
                to_char(created_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as created_at,
                before_data,
                after_data
           from public.audit_logs
           ${whereSql}
          order by created_at desc, id desc
          limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, limit, offset],
      ),
      db
        .query<{ entity_table: string }>(
          `select distinct entity_table from public.audit_logs order by entity_table limit 80`,
        )
        .catch(() => ({ rows: [] })),
    ]);

    return {
      totalCount: Number(countRes.rows[0]?.total ?? 0),
      distinctTables: tablesRes.rows.map((r) => r.entity_table),
      rows: listRes.rows.map((x) => {
        const actorFromAfter =
          x.after_data && typeof x.after_data.actor === "string"
            ? x.after_data.actor
            : x.after_data && typeof x.after_data.actorLabel === "string"
              ? x.after_data.actorLabel
              : null;
        const resolvedActor = x.actor
          ? usersMap.get(x.actor) ?? actorFromAfter ?? `${x.actor.slice(0, 8)}…`
          : actorFromAfter ?? "Sistem (Otomasyon)";
        return {
          id: x.id,
          actor: resolvedActor,
          action: x.action,
          entity: x.entity_id ? `${x.entity_table} · ${x.entity_id}` : x.entity_table,
          created_at: x.created_at,
          before: x.before_data == null ? "—" : JSON.stringify(x.before_data),
          after: x.after_data == null ? "—" : JSON.stringify(x.after_data),
        };
      }) as AuditRow[],
    };
  });

  const extraParams: Record<string, string> = {};
  if (entityFilter) extraParams.entityTable = entityFilter;
  if (actionFilter) extraParams.action = actionFilter;
  if (actorFilter) extraParams.actor = actorFilter;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Denetim Kayıtları (Değiştirilemez Soykütük)"
        subtitle="Kim yaptı (actor), hangi tabloda, ne zaman — tüm finansal ve sistemsel mutasyonların önce/sonra kanıt izi"
      />
      <Panel title={`Denetim Kayıtları (${totalCount} eşleşen kayıt)`}>
        <form method="get" className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-5">
          <select
            name="entityTable"
            defaultValue={entityFilter}
            className="field-control px-2.5 py-1.5 text-xs"
          >
            <option value="">Tüm Tablolar ({distinctTables.length})</option>
            {distinctTables.map((tbl) => (
              <option key={tbl} value={tbl}>
                {tbl}
              </option>
            ))}
          </select>
          <input
            name="action"
            defaultValue={actionFilter}
            placeholder="İşlem filtresi (ör. mark_paid, create_)"
            className="field-control px-2.5 py-1.5 font-mono text-xs"
          />
          <input
            name="actor"
            defaultValue={actorFilter}
            placeholder="Kim yaptı (kullanıcı adı veya ad)"
            className="field-control px-2.5 py-1.5 text-xs"
          />
          <button type="submit" className="button-accent px-3 py-1.5 text-xs font-medium">
            Filtrele
          </button>
          {entityFilter || actionFilter || actorFilter ? (
            <Link href="/system/audit" className="button-ghost px-3 py-1.5 text-center text-xs">
              Filtreyi Temizle
            </Link>
          ) : null}
        </form>

        <AuditTable rows={rows} />
        <PaginationBar
          basePath="/system/audit"
          page={page}
          pageSize={limit}
          totalCount={totalCount}
          params={extraParams}
        />
      </Panel>
    </div>
  );
}
