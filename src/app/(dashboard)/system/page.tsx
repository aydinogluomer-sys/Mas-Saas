import Link from "@/components/ui/app-link";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import type { ChartModel } from "@/lib/analytics/chart";
import { getPool } from "@/lib/db";
import { loadSystemQualityHeader } from "@/lib/data-quality/engine";
import { loadMetricHistories } from "@/lib/analytics/snapshots";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { refreshMetricsAction } from "./actions";
import pkg from "../../../../package.json";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const SYSTEM_METRIC_KEYS = [
  "decision_confidence",
  "data_reviews_open",
  "data_missing_amounts",
  "cash_worst_closing",
] as const;

const SYSTEM_METRIC_LABELS: Record<string, { label: string; isCurrency?: boolean }> = {
  decision_confidence: { label: "Karar Güveni (%)" },
  data_reviews_open: { label: "Açık Veri İncelemesi" },
  data_missing_amounts: { label: "Eksik Tutarlı Kayıt" },
  cash_worst_closing: { label: "En Düşük Kapanış Projeksiyonu", isCurrency: true },
};

export default async function StatusPage({
  searchParams,
}: {
  searchParams: Promise<{ metrics?: string }>;
}) {
  const denied = await requireRouteAccess("/system");
  if (denied) return denied;
  const sp = await searchParams;
  const p = getPool();
  const [dbProbe, dq, combinedHistory] = await Promise.all([
    p.query("select 1").then(() => true).catch(() => false),
    loadSystemQualityHeader(p).catch(() => ({
      decisionConfidence: 0,
      decisionConfidenceLabel: "düşük",
      workbookVersions: [],
    })),
    loadMetricHistories(p, SYSTEM_METRIC_KEYS, 30).catch(() => []),
  ]);
  const db = dbProbe ? "çalışıyor" : "hata";
  const confidencePoints = combinedHistory
    .filter((r) => r.metric_key === "decision_confidence" && r.value_numeric != null)
    .slice()
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
    .map((r) => ({
      key: r.snapshot_date,
      label: r.snapshot_date,
      value: Number(r.value_numeric ?? 0),
    }));
  const metricChartModel: ChartModel | null =
    confidencePoints.length >= 2
      ? {
          title: "Karar Güveni Tarihsel İzi (%)",
          description: "Son 30 günlük sistem veri kalitesi ve karar güveni anlık görüntüleri",
          asOf: confidencePoints[confidencePoints.length - 1]?.key ?? new Date().toISOString().slice(0, 10),
          sourceLabel: "Sistem metrik anlık görüntüleri",
          sourceHref: "/system/diagnostics",
          timeDirection: "historical",
          summaryMode: "endpoint",
          availableGranularities: ["day", "week", "month"],
          series: [
            {
              id: "decision_confidence",
              label: "Karar Güveni (%)",
              tone: "positive",
              format: "percent",
              points: confidencePoints,
            },
          ],
        }
      : null;

  return (
    <>
      <PageHeader
        title="Sistem Durumu"
        subtitle="Uygulama, veritabanı, sürüm ve son içe aktarım"
        action={
          <div className="flex gap-2">
            <Link href="/system/diagnostics" className="button-ghost px-3 py-2">
              Tanılama
            </Link>
            <form action={refreshMetricsAction}>
              <button className="button-accent px-3 py-2">Metrikleri yenile</button>
            </form>
          </div>
        }
      />

      {sp.metrics && (
        <p className="border border-pos bg-pos/10 p-2 text-sm text-pos">
          {sp.metrics} metrik snapshot’ı yenilendi.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiCard label="Uygulama" value="çalışıyor" tone="pos" />
        <KpiCard label="Veritabanı" value={db} tone={db === "çalışıyor" ? "pos" : "neg"} />
        <KpiCard label="Sürüm" value={pkg.version} />
        <KpiCard label="Karar güveni" value={`%${dq.decisionConfidence}`} />
      </div>

      <Panel title="Son içe aktarım">
        <p className="text-sm">{dq.workbookVersions[0]?.original_filename ?? "İçe aktarım yok"}</p>
        <p className="text-xs text-tone-3">{dq.workbookVersions[0]?.imported_at ?? "—"}</p>
      </Panel>

      {metricChartModel ? (
        <Panel title="KARAR GÜVENİ GRAFİK İZİ" subtitle="Günlük karar güveni metrik anlık görüntüleri">
          <AnalyticsChart model={metricChartModel} defaultPeriod="3m" height={240} />
        </Panel>
      ) : null}

      <Panel
        title="TARİHSEL METRİK TRENDİ (METRIC_SNAPSHOTS)"
        subtitle="Son 30 gün · karar güveni, veri kalitesi ve projeksiyon sağlık izi"
      >
        {combinedHistory.length === 0 ? (
          <EmptyState>
            Son 30 günde kaydedilmiş sistem metrik snapshot’ı yok. Yukarıdaki &ldquo;Metrikleri yenile&rdquo; komutu ile anlık görüntü alabilirsiniz.
          </EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Tarih</th>
                  <th>Metrik</th>
                  <th className="text-right">Değer</th>
                  <th className="text-right">Bilinmeyen</th>
                  <th className="text-right">Güven</th>
                  <th className="text-right">Kesim Saati</th>
                </tr>
              </thead>
              <tbody>
                {combinedHistory.slice(0, 24).map((row) => {
                  const meta = SYSTEM_METRIC_LABELS[row.metric_key] ?? { label: row.metric_key };
                  const formattedValue =
                    row.value_numeric == null
                      ? row.value_text ?? "—"
                      : meta.isCurrency
                        ? fmtTL(row.value_numeric)
                        : String(Math.round(row.value_numeric * 100) / 100);
                  return (
                    <tr
                      key={`${row.snapshot_date}-${row.metric_key}-${row.dimension_key}`}
                      className="border-t border-line-faint"
                    >
                      <td className="py-1.5 font-mono">{row.snapshot_date}</td>
                      <td>{meta.label}</td>
                      <td className="text-right font-mono">{formattedValue}</td>
                      <td className="text-right font-mono text-tone-3">{row.unknown_count}</td>
                      <td className="text-right">
                        <Badge
                          tone={
                            row.confidence === "high"
                              ? "green"
                              : row.confidence === "medium"
                                ? "amber"
                                : "neutral"
                          }
                        >
                          {row.confidence}
                        </Badge>
                      </td>
                      <td className="text-right font-mono text-tone-3">{row.source_cutoff}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>
    </>
  );
}
