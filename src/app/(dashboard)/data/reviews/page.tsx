import { getPool } from "@/lib/db";
import { ReviewsTriageDesk, type Review } from "@/components/imports/reviews-triage-desk";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { Button } from "@/components/ui/primitives/button";
import { Input, Select } from "@/components/ui/primitives/input";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; severity?: string; q?: string }>;
}) {
  const denied = await requireRouteAccess("/data/reviews");
  if (denied) return denied;
  const session = await requireSession();
  const canMutate = can(session.role, "mapping_reviews", "update");
  const sp = await searchParams;
  const status = sp.status ?? "open";
  const severity = sp.severity ?? "all";
  const q = (sp.q ?? "").trim();
  const rows = (
    await getPool().query<Review>(
      `select m.id::text,m.workbook_id::text,w.original_filename workbook_name,s.sheet_name,r.row_index,m.issue_type,m.severity,m.message,m.status from mapping_reviews m join source_workbooks w on w.id=m.workbook_id left join source_sheets s on s.id=m.sheet_id left join import_rows r on r.id=m.import_row_id where ($1='all' or m.status=$1) and ($2='all' or m.severity=$2) and ($3='' or m.message ilike '%'||$3||'%' or m.issue_type ilike '%'||$3||'%') order by case m.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,m.created_at`,
      [status, severity, q],
    )
  ).rows;
  const back = `/data/reviews?status=${status}&severity=${severity}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  return (
    <>
      <PageHeader
        title="İnceleme Kuyruğu"
        subtitle="Veri anomalilerini grup özetleriyle topluca karara bağlayın, kaynağıyla inceleyin veya göreve dönüştürün."
        meta={
          <Badge tone={rows.length > 0 ? "amber" : "green"} dot>
            {rows.length} inceleme
          </Badge>
        }
      />
      <Panel title="Filtreler">
        <form className="grid gap-2 sm:grid-cols-[1fr_160px_160px_auto]">
          <Input name="q" defaultValue={q} placeholder="Sorun veya tür ara" className="p-2" />
          <Select name="status" defaultValue={status} className="p-2">
            <option value="open">Açık</option>
            <option value="rejected">Reddedilmiş</option>
            <option value="accepted">Kabul</option>
            <option value="resolved">Çözülmüş</option>
            <option value="all">Tümü</option>
          </Select>
          <Select name="severity" defaultValue={severity} className="p-2">
            <option value="all">Tüm önemler</option>
            <option value="critical">Kritik</option>
            <option value="high">Yüksek</option>
            <option value="medium">Orta</option>
            <option value="low">Düşük</option>
          </Select>
          <Button type="submit" variant="accent" size="md">
            Uygula
          </Button>
        </form>
      </Panel>
      <Panel title={`${rows.length} inceleme`}>
        {rows.length > 0 ? (
          <ReviewsTriageDesk initialRows={rows} canMutate={canMutate} backTo={back} />
        ) : (
          <p className="text-sm text-tone-3">Seçili filtrelere uygun inceleme kaydı yok.</p>
        )}
      </Panel>
    </>
  );
}
