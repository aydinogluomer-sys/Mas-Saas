import Link from "next/link";
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
      <Panel title="WORKBOOK YÜKLE">
        <UploadForm />
      </Panel>
      <Panel title={`İÇE AKTARIMLAR — ${rows.length}`}>
        {rows.length === 0 ? (
          <EmptyState>
            Henüz içe aktarım yok. Excel dosyasını yukarıdan yükleyin — tüm sekmeler ve hücreler
            ham haliyle korunur, belirsiz satırlar eşleme incelemesine düşer.
          </EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                <th className="py-1 pr-2">dosya</th>
                <th className="py-1 pr-2">durum</th>
                <th className="py-1 pr-2">sekme</th>
                <th className="py-1 pr-2">satır</th>
                <th className="py-1 pr-2">açık inceleme</th>
                <th className="py-1">tarih</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="border-b border-line-faint">
                  <td className="max-w-[280px] truncate py-2 pr-2">
                    <Link className="underline decoration-line-strong underline-offset-2 hover:text-tone-1" href={`/imports/${w.id}`}>
                      {w.original_filename}
                    </Link>
                    {w.status === "failed" && w.parse_error ? (
                      <div className="mt-1 truncate font-mono text-[10px] text-neg">{w.parse_error}</div>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2"><Badge tone={STATUS_TONE[w.status] ?? "neutral"}>{w.status}</Badge></td>
                  <td className="py-2 pr-2"><Num>{w.sheet_count}</Num></td>
                  <td className="py-2 pr-2"><Num>{w.row_count}</Num></td>
                  <td className="py-2 pr-2">
                    {w.open_reviews > 0 ? <Badge tone="amber">{w.open_reviews}</Badge> : <Num>0</Num>}
                  </td>
                  <td className="py-2 font-mono text-xs text-tone-2">{w.imported_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
