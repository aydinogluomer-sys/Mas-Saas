import { getPool } from "@/lib/db";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { Num, Panel } from "@/components/ui/panel";
import { EmptyState, PageHeader } from "@/components/ui/shell";
import { V2ImportFlow } from "@/components/imports/v2-import-flow";
import { SCHEMA_NAME, SCHEMA_VERSION, TEMPLATE_VERSION, DATA_SHEETS } from "@/lib/importers/v2/contract";
import { TEMPLATE_FILENAME } from "@/lib/importers/v2/template";

export const dynamic = "force-dynamic";

interface V2WorkbookRow {
  id: string;
  original_filename: string;
  file_sha256: string | null;
  status: string;
  imported_at: string;
  imported_by_name: string | null;
  row_count: number;
  open_reviews: number;
}

export default async function StandardImportV2Page() {
  // PHASE 4 (plan §4.4 "unauthorized role → 403"): sayfa seviyesi rol kapısı — navigasyonla AYNI
  // karar (canSeeRoute). Sunucu eylemleri ayrıca kendi başlarına sorar (actions.ts authorize()).
  const denied = await requireRouteAccess("/data/imports/v2");
  if (denied) return denied;

  const { rows } = await getPool().query<V2WorkbookRow>(`
    select w.id, w.original_filename, w.file_sha256, w.status,
           to_char(w.imported_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as imported_at,
           u.display_name as imported_by_name,
           (select count(*)::int from public.import_rows r where r.workbook_id = w.id) as row_count,
           (select count(*)::int from public.mapping_reviews m where m.workbook_id = w.id and m.status = 'open') as open_reviews
    from public.source_workbooks w
    left join public.users u on u.id = w.imported_by
    where w.notes like 'Standart Import V2%'
    order by w.imported_at desc
    limit 30
  `);

  return (
    <>
      <PageHeader
        title="Standart içe aktarım (V2)"
        subtitle={`${SCHEMA_NAME} v${SCHEMA_VERSION} · şablon ${TEMPLATE_VERSION} · ${DATA_SHEETS.length} veri sayfası`}
      />

      {/* Modern Template Download Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border border-emerald-500/25 bg-gradient-to-r from-emerald-500/10 via-surface-2 to-surface-2 p-5 shadow-lg shadow-emerald-500/5">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
            <svg className="h-6 w-6 stroke-current stroke-2 fill-none" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-sans text-sm font-bold text-tone-1">Standart Finansal Excel Şablonu</span>
              <Badge tone="green">v{TEMPLATE_VERSION}</Badge>
            </div>
            <p className="mt-0.5 font-sans text-xs text-tone-3">
              {DATA_SHEETS.length} veri tablosu sözleşmeden dinamik üretilir. Başlıkları değiştirmeden dilediğiniz sekmeleri doldurun.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <a
            data-hard-nav="true"
            href="/data/imports/v2/template"
            className="button-ghost px-4 py-2.5 text-xs font-semibold flex items-center gap-2 border-emerald-500/30 hover:border-emerald-500/60 hover:bg-emerald-500/10 text-emerald-300"
            download={TEMPLATE_FILENAME}
          >
            <svg className="h-4 w-4 stroke-current stroke-2 fill-none" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Şablonu İndir (.xlsx)
          </a>
        </div>
      </div>

      <Panel
        title="Dosya Yükleme & Doğrulama"
        subtitle="Önizleme hiçbir veri yazmaz. Onay tek bir veritabanı işlemidir: ya tamamı yazılır ya hiçbiri."
      >
        <V2ImportFlow />
      </Panel>

      <Panel
        title="Son Standart Aktarımlar"
        right={<Badge tone="neutral">{rows.length} aktarım</Badge>}
      >
        {rows.length === 0 ? (
          <EmptyState title="Henüz Standart V2 Aktarımı Yok">
            Excel şablonunu yukarıdan indirip doldurun ve önizleyin; tüm satırlar atomik işlemle güvenle aktarılacaktır.
          </EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-sans text-[11px] font-semibold text-tone-3">
                <th className="py-2 pr-3">Dosya</th>
                <th className="py-2 pr-3">SHA256</th>
                <th className="py-2 pr-3">Durum</th>
                <th className="py-2 pr-3">Satır</th>
                <th className="py-2 pr-3">Açık İnceleme</th>
                <th className="py-2 pr-3">Yükleyen</th>
                <th className="py-2">Tarih</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="border-b border-line-faint">
                  <td className="max-w-[260px] truncate py-2.5 pr-3 font-medium text-tone-1">
                    <a data-hard-nav="true" className="hover:text-sky-400 hover:underline transition-colors" href={`/data/imports/${w.id}`}>{w.original_filename}</a>
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-[11px] text-tone-3">{w.file_sha256 ? `${w.file_sha256.slice(0, 12)}…` : "—"}</td>
                  <td className="py-2.5 pr-3"><Badge tone={STATUS_TONE[w.status] ?? "neutral"}>{w.status}</Badge></td>
                  <td className="py-2.5 pr-3"><Num>{w.row_count}</Num></td>
                  <td className="py-2.5 pr-3">{w.open_reviews > 0 ? <Badge tone="amber">{w.open_reviews}</Badge> : <Num>0</Num>}</td>
                  <td className="py-2.5 pr-3 text-xs text-tone-2">{w.imported_by_name ?? "—"}</td>
                  <td className="py-2.5 font-sans text-xs text-tone-2">{w.imported_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
