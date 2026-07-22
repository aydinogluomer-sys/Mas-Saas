import Link from "next/link";
import { getPool } from "@/lib/db";
import { setReviewStatusAction } from "@/app/(dashboard)/imports/actions";
import { createActionFromReviewAction } from "@/app/(dashboard)/data-quality/actions";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { Button } from "@/components/ui/primitives/button";
import { Input, Select } from "@/components/ui/primitives/input";

export const dynamic = "force-dynamic";

type Review = { id: string; workbook_id: string; workbook_name: string; sheet_name: string | null; row_index: number | null; issue_type: string; severity: string; message: string; status: string };

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<{ status?: string; severity?: string; q?: string }> }) {
  const sp = await searchParams;
  const status = sp.status ?? "open";
  const severity = sp.severity ?? "all";
  const q = (sp.q ?? "").trim();
  const rows = (await getPool().query<Review>(`select m.id::text,m.workbook_id::text,w.original_filename workbook_name,s.sheet_name,r.row_index,m.issue_type,m.severity,m.message,m.status from mapping_reviews m join source_workbooks w on w.id=m.workbook_id left join source_sheets s on s.id=m.sheet_id left join import_rows r on r.id=m.import_row_id where ($1='all' or m.status=$1) and ($2='all' or m.severity=$2) and ($3='' or m.message ilike '%'||$3||'%' or m.issue_type ilike '%'||$3||'%') order by case m.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,m.created_at`, [status, severity, q])).rows;
  const back = `/data/reviews?status=${status}&severity=${severity}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  return (
    <>
      <PageHeader title="İnceleme Kuyruğu" subtitle="Veri anomalilerini kaynağıyla inceleyin, karara bağlayın veya göreve dönüştürün." />
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
          <Button type="submit" variant="accent" size="md">Uygula</Button>
        </form>
      </Panel>
      <Panel title={`${rows.length} inceleme`}>
        {rows.map((r) => (
          <article key={r.id} className="border-b border-line-faint py-3">
            <div className="grid gap-2 lg:grid-cols-[150px_1fr_220px]">
              <div>
                <Badge tone={r.severity === "critical" ? "red" : r.severity === "high" ? "amber" : "neutral"}>{r.severity}</Badge>
                <div className="mt-1 text-xs">{r.issue_type}</div>
              </div>
              <div>
                <b>{r.message}</b>
                <p className="mt-1 text-xs text-tone-3">Etkilenen kaynak: {r.workbook_name} · {r.sheet_name ?? "sekme yok"}{r.row_index ? ` · satır ${r.row_index}` : ""}</p>
              </div>
              <div className="flex flex-wrap items-start gap-1">
                <Link className="button-ghost px-2 py-1" href={`/imports/${r.workbook_id}/reviews`}>Kaynağı aç</Link>
                {([["accepted", "Kabul"], ["resolved", "Çöz"], ["rejected", "Reddet"]] as const).map(([s, l]) => (
                  <form key={s} action={setReviewStatusAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="status" value={s} />
                    <input type="hidden" name="backTo" value={back} />
                    <Button type="submit">{l}</Button>
                  </form>
                ))}
                <form action={createActionFromReviewAction}>
                  <input type="hidden" name="reviewId" value={r.id} />
                  <input type="hidden" name="backTo" value={back} />
                  <Button type="submit" variant="accent">Görev oluştur</Button>
                </form>
              </div>
            </div>
          </article>
        ))}
      </Panel>
    </>
  );
}
