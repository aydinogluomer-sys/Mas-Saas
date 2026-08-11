import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { Badge, SHEET_TYPE_TONE, STATUS_TONE } from "@/components/ui/badge";
import { Num, Panel } from "@/components/ui/panel";
import { mapCandidatesAction } from "@/app/(dashboard)/radar/actions";
import { mapCashflowAction } from "@/app/(dashboard)/cashflow/actions";
import { mapFinancingAction } from "@/app/(dashboard)/financing/actions";
import { mapProductionAction } from "@/app/(dashboard)/production/actions";

export const dynamic = "force-dynamic";

export default async function WorkbookDetailPage({
  params,
}: {
  params: Promise<{ workbookId: string }>;
}) {
  const { workbookId } = await params;
  const pool = getPool();
  const wb = await pool.query(
    `select id, original_filename, file_sha256, status, parse_error, notes,
            to_char(imported_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as imported_at
     from public.source_workbooks where id = $1`,
    [workbookId],
  );
  if (wb.rowCount === 0) notFound();
  const w = wb.rows[0];

  const sheets = await pool.query(
    `select s.id, s.sheet_index, s.sheet_name, s.detected_type, s.parse_confidence,
            s.used_range, s.row_count, s.column_count,
            (select count(*)::int from public.mapping_reviews m where m.sheet_id = s.id and m.status='open') as open_reviews
     from public.source_sheets s where s.workbook_id = $1 order by s.sheet_index`,
    [workbookId],
  );
  const openTotal = sheets.rows.reduce((a, s) => a + s.open_reviews, 0);

  return (
    <>
      <Panel
        title={w.original_filename}
        right={<Badge tone={STATUS_TONE[w.status] ?? "neutral"}>{w.status}</Badge>}
      >
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <div><div className="font-mono text-[9px] uppercase text-tone-3">sha256</div><div className="truncate font-mono">{w.file_sha256}</div></div>
          <div><div className="font-mono text-[9px] uppercase text-tone-3">tarih</div><div className="font-mono">{w.imported_at}</div></div>
          <div><div className="font-mono text-[9px] uppercase text-tone-3">özet</div><div className="font-mono">{w.notes ?? "—"}</div></div>
          <div>
            <div className="font-mono text-[9px] uppercase text-tone-3">incelemeler</div>
            <Link href={`/data/imports/${w.id}/reviews`} className="underline decoration-line-strong underline-offset-2">
              {openTotal} açık inceleme →
            </Link>
          </div>
        </div>
        {w.status === "parsed" && (
          <form action={mapCandidatesAction} className="mt-3">
            <input type="hidden" name="workbookId" value={w.id} />
            <button type="submit"
              className="border border-pos tint-pos px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-pos">
              kabul edilenleri radar&apos;a aktar →
            </button>
            <span className="ml-2 text-[11px] text-tone-3">açık/ret incelemeli ve isimsiz satırlar aktarılmaz; tekrar güvenlidir</span>
          </form>
        )}
        {w.status === "parsed" && (
          <form action={mapCashflowAction} className="mt-2">
            <input type="hidden" name="workbookId" value={w.id} />
            <button type="submit"
              className="border border-info tint-info px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-info">
              nakit akışını aktar →
            </button>
            <span className="ml-2 text-[11px] text-tone-3">35 aylık sekmeler → cashflow; zincir kırıkları bayraklanır, düzeltilmez</span>
          </form>
        )}
        {w.status === "parsed" && (
          <form action={mapFinancingAction} className="mt-2">
            <input type="hidden" name="workbookId" value={w.id} />
            <button type="submit"
              className="border border-violet-700 bg-violet-950/40 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-violet-300">
              çek/kredi aktar →
            </button>
            <span className="ml-2 text-[11px] text-tone-3">ÇEKLER → çek defteri (işaretli tutar=yön), faiz hesaplama → kredi+taksit; çift-kayıt/açık incelemeler hariç</span>
          </form>
        )}
        {w.status === "parsed" && (
          <form action={mapProductionAction} className="mt-2">
            <input type="hidden" name="workbookId" value={w.id} />
            <button type="submit"
              className="border border-warn tint-warn px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-warn">
              üretim analitiğini aktar →
            </button>
            <span className="ml-2 text-[11px] text-tone-3">kapasite → parçalar+model, maliyet-mastechnic(mesaili) → başabaş TL/dk; analitik tahmin, stale-rate bayraklı</span>
          </form>
        )}
        {w.status === "failed" && (
          <div className="mt-3 border border-neg tint-neg p-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-neg">parse hatası</div>
            <div className="mt-1 font-mono text-xs text-neg">{w.parse_error}</div>
            <div className="mt-1 text-xs text-tone-2">
              Dosya bozuk görünüyor (ör. tamamen sıfır baytlık aktarım). Kaynağı yeniden dışa aktarıp tekrar yükleyin —
              bu kayıt denetim izi olarak saklanır.
            </div>
          </div>
        )}
      </Panel>

      {sheets.rows.length > 0 && (
        <Panel title={`SEKMELER — ${sheets.rows.length} (hiçbiri atlanmadı)`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                <th className="py-1 pr-2">#</th>
                <th className="py-1 pr-2">sekme</th>
                <th className="py-1 pr-2">tip</th>
                <th className="py-1 pr-2">güven</th>
                <th className="py-1 pr-2">aralık</th>
                <th className="py-1">inceleme</th>
              </tr>
            </thead>
            <tbody>
              {sheets.rows.map((s) => (
                <tr key={s.id} className="border-b border-line-faint">
                  <td className="py-1.5 pr-2 font-mono text-xs text-tone-3">{s.sheet_index}</td>
                  <td className="py-1.5 pr-2">
                    <Link className="underline decoration-line-strong underline-offset-2 hover:text-tone-1"
                      href={`/data/imports/${workbookId}/sheets/${s.id}`}>
                      {s.sheet_name}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Badge tone={SHEET_TYPE_TONE[s.detected_type] ?? "neutral"}>{s.detected_type}</Badge>
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-xs text-tone-2">{s.parse_confidence}</td>
                  <td className="py-1.5 pr-2 font-mono text-xs text-tone-2">
                    {s.used_range ?? "—"} · <Num>{s.row_count}</Num>×<Num>{s.column_count}</Num>
                  </td>
                  <td className="py-1.5">{s.open_reviews > 0 ? <Badge tone="amber">{s.open_reviews}</Badge> : <span className="text-tone-4">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
