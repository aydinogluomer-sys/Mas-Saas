import { getPool } from "@/lib/db";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { Num, Panel } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/shell";
import { UploadForm } from "@/components/imports/upload-form";

export const dynamic = "force-dynamic";

interface WorkbookListRow {
  id: string;
  original_filename: string;
  status: string;
  parse_error: string | null;
  imported_at: string;
  sheet_count: number;
  row_count: number;
  open_reviews: number;
}

export default async function ImportsPage() {
  const { rows } = await getPool().query<WorkbookListRow>(`
    select w.id, w.original_filename, w.status, w.parse_error,
           to_char(w.imported_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as imported_at,
           (select count(*)::int from public.source_sheets s where s.workbook_id = w.id) as sheet_count,
           (select count(*)::int from public.import_rows r where r.workbook_id = w.id) as row_count,
           (select count(*)::int from public.mapping_reviews m where m.workbook_id = w.id and m.status = 'open') as open_reviews
    from public.source_workbooks w
    order by w.imported_at desc
  `);

  return (
    <>
      <Panel
        title="Excel Çalışma Kitabı Yükle"
        subtitle="Veri tablolarını içe aktarın; satır doğrulaması ve mutabakat için otomatik incelemeye alın."
      >
        <UploadForm />
      </Panel>
      <Panel
        title="İçe Aktarılan Dosyalar"
        right={<Badge tone="neutral">{rows.length} dosya</Badge>}
      >
        {rows.length === 0 ? (
          <EmptyState title="Henüz İçe Aktarılmış Dosya Yok">
            Excel dosyasını yukarıdaki yükleme alanına bırakın — tüm sekmeler ve hücreler ham haliyle korunur, belirsiz satırlar eşleme incelemesine düşer.
          </EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-sans text-[11px] font-semibold text-tone-3">
                <th className="py-2 pr-3">Dosya</th>
                <th className="py-2 pr-3">Durum</th>
                <th className="py-2 pr-3">Sekme</th>
                <th className="py-2 pr-3">Satır</th>
                <th className="py-2 pr-3">Açık İnceleme</th>
                <th className="py-2">Yükleme Tarihi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="border-b border-line-faint">
                  <td className="max-w-[280px] truncate py-2.5 pr-3 font-medium text-tone-1">
                    <a data-hard-nav="true" className="hover:text-sky-400 hover:underline transition-colors" href={`/data/imports/${w.id}`}>
                      {w.original_filename}
                    </a>
                    {w.status === "failed" && w.parse_error ? (
                      <div className="mt-1 truncate font-mono text-[10px] text-neg">{w.parse_error}</div>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-3"><Badge tone={STATUS_TONE[w.status] ?? "neutral"}>{w.status}</Badge></td>
                  <td className="py-2.5 pr-3"><Num>{w.sheet_count}</Num></td>
                  <td className="py-2.5 pr-3"><Num>{w.row_count}</Num></td>
                  <td className="py-2.5 pr-3">
                    {w.open_reviews > 0 ? <Badge tone="amber">{w.open_reviews}</Badge> : <Num>0</Num>}
                  </td>
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
