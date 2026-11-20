import Link from "@/components/ui/app-link";
import { getRequestUser } from "@/lib/auth";
import { canSeeRoute } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { Num, Panel } from "@/components/ui/panel";
import { EmptyState, PageHeader, TableShell } from "@/components/ui/shell";
import { ColumnMappingWizard } from "@/components/imports/column-mapping-wizard";
import { requireRouteAccess } from "@/lib/authz/route-guard";

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

const WORKBOOK_STATUS_TR: Record<string, string> = {
  completed: "tamamlandı",
  parsed: "ayrıştırıldı",
  imported: "içe aktarıldı",
  pending: "bekliyor",
  failed: "hatalı",
  rejected: "reddedildi",
};

export default async function ImportsPage() {
  const denied = await requireRouteAccess("/data/imports");
  if (denied) return denied;
  const session = await getRequestUser();
  const role = session?.role ?? "viewer";
  const canImportV2 = canSeeRoute(role, "/data/imports/v2");
  const canSeeBridge = canSeeRoute(role, "/data/trial-balance-bridge");
  const canSeeIntegrations = canSeeRoute(role, "/data/integrations");
  const { rows } = await getPool().query<WorkbookListRow>(`
    select w.id, w.original_filename, w.status, w.parse_error,
           to_char(w.imported_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as imported_at,
           (select count(*)::int from public.source_sheets s where s.workbook_id = w.id) as sheet_count,
           (select count(*)::int from public.import_rows r where r.workbook_id = w.id) as row_count,
           (select count(*)::int from public.mapping_reviews m where m.workbook_id = w.id and m.status = 'open') as open_reviews
    from public.source_workbooks w
    order by w.imported_at desc
  `);

  const openReviewsTotal = rows.reduce((sum, r) => sum + (r.open_reviews ?? 0), 0);
  const hasHeaderActions = canImportV2 || canSeeBridge || canSeeIntegrations;

  return (
    <div className="space-y-3.5">
      <PageHeader
        title="Veri İçe Aktarım Merkezi"
        subtitle="3 adımlı akıllı kolon eşleştirme sihirbazı (.xlsx & .csv) · V2 atomik motoru · tam kaynak izlenebilirliği"
        action={
          hasHeaderActions ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {canImportV2 ? (
                <Link href="/data/imports/v2" className="button-ghost px-2.5 py-1 text-[11.5px]">
                  V2 Şablon (17 Sayfa) →
                </Link>
              ) : null}
              {canSeeBridge ? (
                <Link href="/data/trial-balance-bridge" className="button-ghost px-2.5 py-1 text-[11.5px]">
                  SMMM Mizan Köprüsü →
                </Link>
              ) : null}
              {canSeeIntegrations ? (
                <Link href="/data/integrations" className="button-accent px-2.5 py-1 text-[11.5px]">
                  Canlı Entegrasyonlar →
                </Link>
              ) : null}
            </div>
          ) : undefined
        }
      />

      <Panel
        title="Akıllı Kolon Eşleştirme ve İçe Aktarım Sihirbazı (.xlsx & .csv)"
        subtitle="Sabit şablon dayatması olmadan herhangi bir Excel veya CSV dosyasının başlıklarını V2 veri alanlarıyla eşleştirip tek atomik işlemde içe aktarın"
      >
        <ColumnMappingWizard templateHref={canImportV2 ? "/data/imports/v2/template" : null} />
      </Panel>

      <details className="parchment-disclosure" open={rows.length <= 6}>
        <summary>
          <span className="flex items-center gap-2.5">
            <span className="parchment-disclosure-chevron" aria-hidden="true">
              ▸
            </span>
            <span className="block">
              <span className="block text-[13.5px] font-semibold text-tone-1">
                İçe Aktarım Geçmişi ve Kaynak İzi ({rows.length} çalışma kitabı)
              </span>
              <span className="block text-[11.5px] font-normal text-tone-3">
                Ham sayfa, satır ve inceleme kuyruğu soykütüğü
              </span>
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">{rows.length} dosya</Badge>
            {openReviewsTotal > 0 ? (
              <Badge tone="amber">{openReviewsTotal} açık inceleme</Badge>
            ) : null}
          </span>
        </summary>
        <div className="parchment-disclosure-body">
          {rows.length === 0 ? (
            <EmptyState>
              Henüz içe aktarım yok. Excel (.xlsx) veya CSV (.csv) dosyasını yukarıdaki 3 adımlı sihirbazla
              yükleyin — tüm hücreler ham haliyle korunur, belirsiz satırlar eşleme incelemesine düşer.
            </EmptyState>
          ) : (
            <TableShell>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left font-mono text-xs uppercase tracking-wider text-tone-3">
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
                      <td className="max-w-70 truncate py-2 pr-2">
                        <a
                          data-hard-nav="true"
                          className="underline decoration-line-strong underline-offset-2 hover:text-tone-1"
                          href={`/data/imports/${w.id}`}
                        >
                          {w.original_filename}
                        </a>
                        {w.status === "failed" && w.parse_error ? (
                          <div className="mt-1 truncate font-mono text-xs text-neg">{w.parse_error}</div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-2">
                        <Badge tone={STATUS_TONE[w.status] ?? "neutral"}>
                          {WORKBOOK_STATUS_TR[w.status] ?? w.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-2">
                        <Num>{w.sheet_count}</Num>
                      </td>
                      <td className="py-2 pr-2">
                        <Num>{w.row_count}</Num>
                      </td>
                      <td className="py-2 pr-2">
                        {w.open_reviews > 0 ? (
                          <Badge tone="amber">{w.open_reviews}</Badge>
                        ) : (
                          <Num>0</Num>
                        )}
                      </td>
                      <td className="py-2 font-mono text-xs text-tone-2">{w.imported_at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          )}
        </div>
      </details>
    </div>
  );
}
