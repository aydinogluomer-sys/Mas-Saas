import { getPool } from "@/lib/db";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { Num, Panel } from "@/components/ui/panel";
import { EmptyState, PageHeader } from "@/components/ui/shell";
import { V2ImportFlow } from "@/components/imports/v2-import-flow";
import { SCHEMA_NAME, SCHEMA_VERSION, TEMPLATE_VERSION, DATA_SHEETS } from "@/lib/importers/v2/contract";
import { COLUMN_TARGETS, targetFor } from "@/lib/importers/v2/domain-map";
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

      <Panel title="1 · ŞABLONU İNDİRİN">
        <div className="flex flex-wrap items-center gap-3">
          <a data-hard-nav="true" href="/data/imports/v2/template" className="button-ghost px-3 py-2 text-xs" download={TEMPLATE_FILENAME}>
            ŞABLONU İNDİR (.xlsx)
          </a>
          <span className="font-mono text-xs text-tone-3">
            şablon sözleşmeden çalışma zamanında üretilir; her indirme aynı sha256&apos;yı verir · yalnız doldurmak istediğiniz sayfaları doldurun · başlıkları değiştirmeyin
          </span>
        </div>
      </Panel>

      <Panel title="2 · YÜKLEYİN → ÖNİZLEYİN → ONAYLAYIN" subtitle="Önizleme hiçbir şey yazmaz. Onay tek bir veritabanı işlemidir: ya tamamı yazılır ya hiçbiri.">
        <V2ImportFlow />
      </Panel>

      <Panel title={`SON STANDART AKTARIMLAR — ${rows.length}`}>
        {rows.length === 0 ? (
          <EmptyState>Henüz V2 aktarımı yok.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-xs uppercase tracking-wider text-tone-3">
                <th className="py-1 pr-2">dosya</th>
                <th className="py-1 pr-2">sha256</th>
                <th className="py-1 pr-2">durum</th>
                <th className="py-1 pr-2">satır</th>
                <th className="py-1 pr-2">açık inceleme</th>
                <th className="py-1 pr-2">kim</th>
                <th className="py-1">tarih</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="border-b border-line-faint">
                  <td className="max-w-65 truncate py-2 pr-2">
                    <a data-hard-nav="true" className="underline decoration-line-strong underline-offset-2 hover:text-tone-1" href={`/data/imports/${w.id}`}>{w.original_filename}</a>
                  </td>
                  <td className="py-2 pr-2 font-mono text-xs text-tone-2">{w.file_sha256 ? `${w.file_sha256.slice(0, 12)}…` : "—"}</td>
                  <td className="py-2 pr-2"><Badge tone={STATUS_TONE[w.status] ?? "neutral"}>{w.status}</Badge></td>
                  <td className="py-2 pr-2"><Num>{w.row_count}</Num></td>
                  <td className="py-2 pr-2">{w.open_reviews > 0 ? <Badge tone="amber">{w.open_reviews}</Badge> : <Num>0</Num>}</td>
                  <td className="py-2 pr-2 text-xs text-tone-2">{w.imported_by_name ?? "—"}</td>
                  <td className="py-2 font-mono text-xs text-tone-2">{w.imported_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title={`3 · SÖZLEŞME → VERİTABANI KOLON EŞLEME HARİTASI (${Object.keys(COLUMN_TARGETS).length} KOLON)`}
        subtitle="Her Excel kolonunun veritabanında hangi tabloya/kolona yazıldığı veya neden yalnız kaynak satırda (import_rows) tutulduğu açıkça kayıtlıdır."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[11px] uppercase tracking-wider text-tone-3">
                <th className="py-1.5 pr-3">Sayfa Kodu</th>
                <th className="py-1.5 pr-3">Başlık</th>
                <th className="py-1.5 pr-3">Hedef Tablo</th>
                <th className="py-1.5 pr-3 text-right">Toplam Kolon</th>
                <th className="py-1.5 pr-3 text-right">Doğrudan (Domain)</th>
                <th className="py-1.5 pr-3 text-right">Üst Kayıt (Parent)</th>
                <th className="py-1.5 pr-3 text-right">External ID (Ledger)</th>
                <th className="py-1.5 pr-3 text-right">Ham Kanıt (import_rows)</th>
                <th className="py-1.5">Kolon Detayı</th>
              </tr>
            </thead>
            <tbody>
              {DATA_SHEETS.map((sheet) => {
                let domainCount = 0;
                let parentCount = 0;
                let ledgerCount = 0;
                let rawOnlyCount = 0;
                for (const col of sheet.columns) {
                  const target = targetFor(sheet.name, col.key);
                  if (!target) continue;
                  if (target.kind === "domain") domainCount++;
                  else if (target.kind === "parent") parentCount++;
                  else if (target.kind === "ledger") ledgerCount++;
                  else if (target.kind === "not_persisted") rawOnlyCount++;
                }
                return (
                  <tr key={sheet.name} className="border-b border-line-faint align-top">
                    <td className="py-1.5 pr-3 font-mono text-tone-1">{sheet.name}</td>
                    <td className="py-1.5 pr-3 text-tone-2">{sheet.title}</td>
                    <td className="py-1.5 pr-3 font-mono text-accent">{sheet.domainTable}</td>
                    <td className="py-1.5 pr-3 text-right"><Num>{sheet.columns.length}</Num></td>
                    <td className="py-1.5 pr-3 text-right"><Badge tone="green">{domainCount}</Badge></td>
                    <td className="py-1.5 pr-3 text-right">{parentCount > 0 ? <Badge tone="blue">{parentCount}</Badge> : <Num>0</Num>}</td>
                    <td className="py-1.5 pr-3 text-right">{ledgerCount > 0 ? <Badge tone="neutral">{ledgerCount}</Badge> : <Num>0</Num>}</td>
                    <td className="py-1.5 pr-3 text-right">{rawOnlyCount > 0 ? <Badge tone="amber">{rawOnlyCount}</Badge> : <Num>0</Num>}</td>
                    <td className="py-1.5">
                      <details className="group">
                        <summary className="cursor-pointer font-mono text-[11px] text-tone-2 underline decoration-line-strong underline-offset-2 hover:text-tone-1">
                          kolonları göster ({sheet.columns.length})
                        </summary>
                        <div className="mt-1.5 grid grid-cols-1 gap-1 border border-line bg-surface p-2 sm:grid-cols-2">
                          {sheet.columns.map((col) => {
                            const t = targetFor(sheet.name, col.key);
                            return (
                              <div key={col.key} className="flex items-start justify-between gap-2 border-b border-line-faint pb-1 text-[11px]">
                                <span className="font-mono text-tone-1">{col.key}</span>
                                <span className="font-mono text-right text-tone-3">
                                  {!t
                                    ? "—"
                                    : t.kind === "domain"
                                      ? `→ ${t.field}`
                                      : t.kind === "parent"
                                        ? `üst → ${t.field}`
                                        : t.kind === "ledger"
                                          ? "import_external_keys"
                                          : `ham (${t.reason})`}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
