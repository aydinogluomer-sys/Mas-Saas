import Link from "@/components/ui/app-link";
import { StackedRibbonSvg, type StackedRibbonSegment } from "@/components/charts/folio-visuals";
import { getPool } from "@/lib/db";
import { listReports } from "@/lib/reports/engine";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, PageHeader } from "@/components/ui/shell";
import { dispatchBriefingAction, generateReportAction } from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const TYPE_TONE: Record<string, Tone> = {
  daily: "green",
  weekly: "blue",
  monthly: "amber",
  strategic: "amber",
  data_quality: "neutral",
  cfo_briefing: "blue",
};
const TYPE_LABEL: Record<string, string> = {
  daily: "Günlük",
  weekly: "Haftalık",
  monthly: "Aylık",
  strategic: "YK & Banka Paketi",
  data_quality: "Veri Kalitesi",
  cfo_briefing: "CFO Brifingi",
};

interface ReportsPageProps {
  searchParams?: Promise<{ dispatched?: string; dispatchError?: string }>;
}

export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  const denied = await requireRouteAccess("/insights/reports");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const pool = getPool();
  const reports = await listReports(pool);

  const countBoardPacks = reports.filter(
    (r) => (r.meta && r.meta.packageKind === "board_pack") || r.report_type === "strategic",
  ).length;
  const countCfoBriefing = reports.filter((r) => r.report_type === "cfo_briefing").length;
  const countMonthly = reports.filter((r) => r.report_type === "monthly").length;
  const countWeekly = reports.filter((r) => r.report_type === "weekly").length;
  const countDaily = reports.filter((r) => r.report_type === "daily").length;
  const countDataQuality = reports.filter((r) => r.report_type === "data_quality").length;

  const reportCompositionSegments: StackedRibbonSegment[] = [
    {
      key: "rep-board",
      label: "YK & Banka Paketi",
      value: countBoardPacks,
      formattedValue: `${countBoardPacks}`,
      tone: "accent",
    },
    {
      key: "rep-briefing",
      label: "CFO Brifingi",
      value: countCfoBriefing,
      formattedValue: `${countCfoBriefing}`,
      tone: "info",
    },
    {
      key: "rep-monthly",
      label: "Aylık",
      value: countMonthly,
      formattedValue: `${countMonthly}`,
      tone: "warn",
    },
    {
      key: "rep-weekly",
      label: "Haftalık",
      value: countWeekly,
      formattedValue: `${countWeekly}`,
      tone: "info",
    },
    {
      key: "rep-daily",
      label: "Günlük",
      value: countDaily,
      formattedValue: `${countDaily}`,
      tone: "pos",
    },
    {
      key: "rep-dq",
      label: "Veri Kalitesi",
      value: countDataQuality,
      formattedValue: `${countDataQuality}`,
      tone: "neutral",
    },
  ];

  const GenButton = ({ type, label, accent = false }: { type: string; label: string; accent?: boolean }) => (
    <form action={generateReportAction}>
      <input type="hidden" name="type" value={type} />
      <button
        type="submit"
        className={
          accent
            ? "button-accent px-3 py-2 font-mono text-[10px] uppercase tracking-wider"
            : "border border-line-strong bg-surface-2 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-tone-1 hover:bg-surface-3"
        }
      >
        {label} üret →
      </button>
    </form>
  );

  return (
    <>
      <PageHeader
        title="Raporlar & Yönetim Kurulu Paketi"
        subtitle="Yönetim Kurulu & Banka Finansal Paketi (TDHP Gelir Tablosu, Bilanço, 13H Likidite, Yaşlandırma & Kovenant) · çok sekmeli .xlsx ve PDF/HTML ihracı"
        meta={<Badge tone="neutral" dot>{reports.length} rapor</Badge>}
      />

      {sp.dispatched ? (
        <div
          role="status"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            color: "var(--text-1)",
          }}
          className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
        >
          <Badge tone="green" dot>Gönderildi</Badge>
          <span>
            {`CFO brifingi ${sp.dispatched === "email" ? "E-posta" : "Telegram"} kanalına başarıyla iletildi ve denetim izine kaydedildi.`}
          </span>
        </div>
      ) : null}

      {sp.dispatchError ? (
        <div
          role="alert"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            color: "var(--text-1)",
          }}
          className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
        >
          <Badge tone="amber" dot>Kanal Uyarısı</Badge>
          <span>{sp.dispatchError}</span>
        </div>
      ) : null}

      <Panel
        title="YÖNETİM KURULU & BANKA PAKETİ VE DÖNEMSEL RAPOR ÜRETİMİ"
        subtitle="5 sekmeli ExcelJS paketi (Özet, Gelir Tablosu, Bilanço, 13 Hafta Likidite, Yaşlandırma & Kovenant) ve yazdırılabilir PDF görünümü"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <GenButton type="board_pack" label="Yönetim Kurulu & Banka Paketi" accent />
            <GenButton type="daily" label="Günlük" />
            <GenButton type="weekly" label="Haftalık" />
            <GenButton type="monthly" label="Aylık" />
          </div>
          <form action={dispatchBriefingAction} className="flex flex-wrap items-center gap-2">
            <select
              name="channel"
              defaultValue="telegram"
              aria-label="Gönderim kanalı"
              style={{
                background: "var(--surface-1)",
                border: "1px solid var(--line)",
                color: "var(--text-1)",
              }}
              className="px-2.5 py-2 font-mono text-[10px] uppercase tracking-wider"
            >
              <option value="telegram">Telegram</option>
              <option value="email">E-posta</option>
            </select>
            <button
              type="submit"
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--line)",
                color: "var(--text-1)",
              }}
              className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider hover:opacity-85"
            >
              Brifingi Kanallara Gönder
            </button>
          </form>
        </div>
        <p className="mt-2 font-mono text-[10px] text-tone-3">
          Raporlar salt-okunur anlık görüntülerdir (Europe/Istanbul). Hiçbir mali kaydı değiştirmez; her rapor çok sekmeli .xlsx, CSV ve yazdırılabilir PDF/HTML olarak dışa aktarılabilir.
        </p>
      </Panel>

      <Panel
        title="ÜRETİLEN RAPOR PAKETİ KOMPOZİSYONU"
        subtitle="Yönetim Kurulu & Banka paketleri, CFO brifingleri ve dönemsel anlık görüntülerin dağılımı"
      >
        <StackedRibbonSvg
          title="Rapor Arşivi Tür Dağılımı"
          segments={reportCompositionSegments}
          emptyLabel="Henüz arşivlenmiş rapor bulunmuyor"
        />
      </Panel>

      <Panel title={`KAYITLI RAPORLAR VE İHRAÇ MERKEZİ — ${reports.length}`}>
        {reports.length === 0 ? (
          <EmptyState>
            Henüz rapor üretilmedi. Yukarıdaki &ldquo;Yönetim Kurulu &amp; Banka Paketi&rdquo; veya günlük / haftalık / aylık komutlarından biriyle başlayın.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                  <th className="py-1 pr-2">tip</th>
                  <th className="py-1 pr-2">dönem</th>
                  <th className="py-1 pr-2">üretim</th>
                  <th className="py-1 pr-2 text-right">dışa aktarım (.xlsx / pdf / csv)</th>
                  <th className="py-1 text-right">kanal iletimi</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => {
                  const isBoardPack = r.meta && r.meta.packageKind === "board_pack";
                  const label = isBoardPack
                    ? "YK & Banka Paketi"
                    : TYPE_LABEL[r.report_type] ?? r.report_type;
                  return (
                    <tr key={r.id} className="border-b border-line-faint">
                      <td className="py-1.5 pr-2">
                        <Link href={`/insights/reports/${r.id}`}>
                          <Badge tone={TYPE_TONE[r.report_type] ?? "neutral"}>{label}</Badge>
                        </Link>
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-xs text-tone-2">
                        {r.period_start === r.period_end ? r.period_start : `${r.period_start} → ${r.period_end}`}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-xs text-tone-3">
                        <Link className="underline decoration-line-strong underline-offset-2" href={`/insights/reports/${r.id}`}>
                          {r.created_at} →
                        </Link>
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono text-[10px]">
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <a
                            href={`/api/reports/${r.id}/export?format=xlsx`}
                            style={{
                              background: "var(--surface-2)",
                              border: "1px solid var(--line)",
                              color: "var(--text-1)",
                            }}
                            className="px-2 py-0.5 uppercase tracking-wider hover:opacity-80"
                          >
                            .XLSX
                          </a>
                          <a
                            href={`/api/reports/${r.id}/export?format=html&print=1`}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              background: "var(--surface-2)",
                              border: "1px solid var(--line)",
                              color: "var(--text-1)",
                            }}
                            className="px-2 py-0.5 uppercase tracking-wider hover:opacity-80"
                          >
                            PDF / YAZDIR
                          </a>
                          <a
                            href={`/api/reports/${r.id}/export?format=csv`}
                            style={{
                              background: "var(--surface-2)",
                              border: "1px solid var(--line)",
                              color: "var(--text-2)",
                            }}
                            className="px-2 py-0.5 uppercase tracking-wider hover:opacity-80"
                          >
                            .CSV
                          </a>
                        </span>
                      </td>
                      <td className="py-1.5 text-right">
                        <form action={dispatchBriefingAction} className="inline-flex items-center gap-1.5">
                          <input type="hidden" name="reportId" value={r.id} />
                          <input type="hidden" name="channel" value="telegram" />
                          <button
                            type="submit"
                            style={{
                              background: "var(--surface-2)",
                              border: "1px solid var(--line)",
                              color: "var(--text-2)",
                            }}
                            className="px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider hover:opacity-80"
                          >
                            Telegram&apos;a ilet
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
