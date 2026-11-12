import { getPool } from "@/lib/db";
import { istanbulDateISO } from "@/lib/reports/rules";
import { ANALYSES, METRICS } from "@/lib/analytics/registry";
import {
  runAgeingDistribution, runCashBridge, runParetoConcentration,
  runPeriodOverPeriod, runVarianceDecomposition, runWorkingCapitalDecomposition,
} from "@/lib/analytics/engine";
import { loadMetricHistory, type MetricSnapshotRow } from "@/lib/analytics/snapshots";
import { heatmapModel, treemapModel, waterfallModel } from "@/lib/analytics/chart-types";
import { formatMetric } from "@/lib/analytics/analyses";
import { describeStamp } from "@/lib/analytics/reproducibility";
import { COMPARISON_LABEL } from "@/lib/analytics/periods";
import { intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { HeatmapChart, TreemapChart, WaterfallChart } from "@/components/charts/advanced-charts";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

interface WorkingCapitalMonthlyRow {
  periodMonth: string;
  receivablesOpen: number | null;
  payablesOpen: number | null;
  netWorkingCapitalExInventory: number | null;
  dsoDays: number | null;
  dpoDays: number | null;
  dioDays: number | null;
  cashCycleExInventory: number | null;
  cashInflowTry: number | null;
  cashOutflowTry: number | null;
  cashNetTry: number | null;
  foreignInvoiceCount: number;
  foreignCashTxCount: number;
}

async function loadWorkingCapitalMonthlySeries(pool: ReturnType<typeof getPool>): Promise<WorkingCapitalMonthlyRow[]> {
  try {
    const res = await pool.query<{
      period_month: string;
      receivables_open: string | number | null;
      payables_open: string | number | null;
      net_working_capital_ex_inventory: string | number | null;
      dso_days: string | number | null;
      dpo_days: string | number | null;
      dio_days: string | number | null;
      cash_cycle_excluding_inventory: string | number | null;
      cash_inflow_try: string | number | null;
      cash_outflow_try: string | number | null;
      cash_net_try: string | number | null;
      foreign_invoice_count: string | number | null;
      foreign_cash_tx_count: string | number | null;
    }>(
      `select to_char(period_start, 'YYYY-MM') as period_month,
              receivables_open,
              payables_open,
              net_working_capital_ex_inventory,
              dso_days,
              dpo_days,
              dio_days,
              cash_cycle_excluding_inventory,
              cash_inflow_try,
              cash_outflow_try,
              cash_net_try,
              foreign_invoice_count,
              foreign_cash_tx_count
         from public.working_capital_monthly_v
        order by period_start desc
        limit 12`,
    );
    return res.rows.map((r) => ({
      periodMonth: r.period_month,
      receivablesOpen: moneyOrNull(r.receivables_open),
      payablesOpen: moneyOrNull(r.payables_open),
      netWorkingCapitalExInventory: moneyOrNull(r.net_working_capital_ex_inventory),
      dsoDays: rateOrNull(r.dso_days),
      dpoDays: rateOrNull(r.dpo_days),
      dioDays: rateOrNull(r.dio_days),
      cashCycleExInventory: rateOrNull(r.cash_cycle_excluding_inventory),
      cashInflowTry: moneyOrNull(r.cash_inflow_try),
      cashOutflowTry: moneyOrNull(r.cash_outflow_try),
      cashNetTry: moneyOrNull(r.cash_net_try),
      foreignInvoiceCount: intOrNull(r.foreign_invoice_count) ?? 0,
      foreignCashTxCount: intOrNull(r.foreign_cash_tx_count) ?? 0,
    }));
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "42P01") return [];
    throw err;
  }
}

const SNAPSHOT_SERIES_META: Array<{
  key: string;
  label: string;
  format: "currency" | "count";
  filterDimension?: string;
}> = [
  { key: "cash_worst_closing", label: "En Düşük Projeksiyon Kapanışı", format: "currency", filterDimension: "total" },
  { key: "maturity_outflow", label: "30 Günlük Vade Çıkışı", format: "currency", filterDimension: "30d" },
  { key: "loan_remaining", label: "Kalan Kredi Anapara", format: "currency", filterDimension: "total" },
  { key: "decision_confidence", label: "Karar Güveni Skoru (%)", format: "count", filterDimension: "total" },
];

export default async function AnalysisPage() {
  // Faz 17-38 denetimi — sayfa seviyesi rol kapisi. Navigasyonun kullandigi AYNI karar
  // (canSeeRoute); ikinci bir liste, ikinci bir fikir ve kacinilmaz bir kayma demekti.
  const denied = await requireRouteAccess("/insights/analysis");
  if (denied) return denied;
  const pool = getPool();
  const asOf = istanbulDateISO();

  const months = await pool.query(
    `select to_char(min(month_start),'YYYY-MM') a, to_char(max(month_start),'YYYY-MM') b
       from public.cashflow_months`);
  const fromMonth = (months.rows[0]?.a as string | null) ?? asOf.slice(0, 7);
  const toMonth = (months.rows[0]?.b as string | null) ?? asOf.slice(0, 7);

  const [
    variance,
    pareto,
    workingCapital,
    bridge,
    ageingSales,
    ageingPurchase,
    pop,
    wcMonthlySeries,
    histWorstClosing,
    histMaturityOutflow,
    histLoanRemaining,
    histDecisionConfidence,
  ] = await Promise.all([
    runVarianceDecomposition(pool, asOf),
    runParetoConcentration(pool, asOf),
    runWorkingCapitalDecomposition(pool, asOf),
    runCashBridge(pool, fromMonth, toMonth, asOf),
    runAgeingDistribution(pool, "sales", asOf),
    runAgeingDistribution(pool, "purchase", asOf),
    runPeriodOverPeriod(pool, "mom", asOf),
    loadWorkingCapitalMonthlySeries(pool),
    loadMetricHistory(pool, "cash_worst_closing", 90),
    loadMetricHistory(pool, "maturity_outflow", 90),
    loadMetricHistory(pool, "loan_remaining", 90),
    loadMetricHistory(pool, "decision_confidence", 90),
  ]);

  const metricHistoryMap: Record<string, MetricSnapshotRow[]> = {
    cash_worst_closing: histWorstClosing,
    maturity_outflow: histMaturityOutflow,
    loan_remaining: histLoanRemaining,
    decision_confidence: histDecisionConfidence,
  };

  const bridgeChart = waterfallModel({
    title: "Nakit köprüsü", description: `${fromMonth} → ${toMonth} nakit hareketi`,
    format: "currency", asOf, sourceLabel: "cashflow_months",
    steps: bridge.result.rows.map((r) => ({ key: r.key, label: r.label, value: r.value, kind: r.kind })),
    unknownCount: bridge.result.unknownCount,
  });

  const varianceChart = waterfallModel({
    title: "Varyans ayrıştırma", description: "Bütçe sapmasına en çok katkı veren kalemler",
    format: "currency", asOf, sourceLabel: "budget_vs_actual",
    steps: variance.result.rows.slice(0, 10).map((r) => ({
      key: r.key, label: r.label, value: r.value,
      kind: r.value >= 0 ? "increase" as const : "decrease" as const,
    })),
    unknownCount: variance.result.unknownCount,
  });

  const paretoChart = treemapModel({
    title: "Alacak yoğunlaşması", description: "Açık alacağın karşı taraflara dağılımı",
    format: "currency", asOf, sourceLabel: "invoices + parties",
    items: pareto.result.rows.map((r) => ({ key: r.key, label: r.label, value: r.value })),
    maxTiles: 12,
  });

  const ageingChart = heatmapModel({
    title: "Yaşlandırma dağılımı", description: "Açık alacak ve borcun vade kovalarına dağılımı",
    format: "currency", asOf, sourceLabel: "invoices",
    rows: [{ key: "sales", label: "Alacak" }, { key: "purchase", label: "Borç" }],
    columns: ageingSales.result.rows.map((r) => ({ key: r.bucketKey, label: r.bucketLabel })),
    values: [
      ...ageingSales.result.rows.map((r) => ({ rowKey: "sales", columnKey: r.bucketKey, value: r.amount })),
      ...ageingPurchase.result.rows.map((r) => ({ rowKey: "purchase", columnKey: r.bucketKey, value: r.amount })),
    ],
  });

  const wcRows = workingCapital.result.rows;
  const recentPop = pop.result.rows.slice(-6).reverse();

  return (
    <>
      <PageHeader
        title="Analiz Merkezi"
        subtitle={`${Object.keys(ANALYSES).length} adlandırılmış analiz · deterministik, yapay zekâ kullanılmaz`}
        meta={<Badge tone="blue" dot>ilk dilim</Badge>}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat
          label="Yoğunlaşma"
          value={pareto.summary ? `${pareto.summary.vitalFewCount} / ${pareto.summary.totalCount}` : "—"}
          tone={pareto.summary && pareto.summary.vitalFewCount <= 3 ? "warn" : "neutral"}
          sub={pareto.summary ? `açık alacağın %${Math.round(pareto.summary.threshold * 100)}'i` : "veri yok"}
        />
        <KeyStat
          label="Nakit döngüsü"
          value={formatMetric(workingCapital.cycleDays, "days")}
          tone="neutral"
          sub="envanter hariç — DIO ölçülemez"
        />
        <KeyStat
          label="Nakit köprüsü mutabık mı"
          value={bridge.reconciles == null ? "—" : bridge.reconciles ? "evet" : "HAYIR"}
          tone={bridge.reconciles === false ? "neg" : bridge.reconciles ? "pos" : "neutral"}
          sub={bridge.result.unmeasurableReason
            ?? (bridge.difference == null ? "kapanış bildirilmemiş" : `fark ${formatMetric(bridge.difference, "currency")}`)}
        />
        <KeyStat
          label="Bütçe sapması olan kalem"
          value={String(variance.result.rows.length)}
          tone={variance.result.rows.length > 0 ? "warn" : "pos"}
          sub={`${variance.result.unknownCount} kalem eksik veri`}
        />
      </div>

      <Panel title="NAKİT KÖPRÜSÜ (ŞELALE)">
        {/* An unknown opening balance is said, not drawn from 0 (cashBridge, Wave 0 R10). */}
        {bridge.result.rows.length === 0 ? <EmptyState>{bridge.result.unmeasurableReason ?? "Nakit akış verisi yok."}</EmptyState> : (
          <>
            <WaterfallChart model={bridgeChart} exportKey="cash_bridge" />
            {/* A bridge that does not add up is reported, never silently drawn. */}
            {bridge.reconciles === false && (
              <p className="mt-2 font-mono text-[11px] text-neg">
                Hesaplanan kapanış ile bildirilen kapanış {formatMetric(bridge.difference, "currency")} farklı —
                köprü mutabık değil, grafik bu farkı gizlemiyor.
              </p>
            )}
            <p className="mt-1 font-mono text-[10px] text-tone-4">{describeStamp(bridge.stamp)}</p>
          </>
        )}
      </Panel>

      <Panel title="ALACAK YOĞUNLAŞMASI (AĞAÇ HARİTASI)">
        {pareto.result.rows.length === 0 ? (
          <EmptyState>{pareto.result.unmeasurableReason ?? "Açık alacak yok."}</EmptyState>
        ) : (
          <>
            <TreemapChart model={paretoChart} exportKey="pareto_concentration" />
            {pareto.summary && (
              <p className="mt-2 font-mono text-[11px] text-tone-2">
                Açık alacağın %{Math.round(pareto.summary.threshold * 100)}&apos;i{" "}
                <strong>{pareto.summary.vitalFewCount}</strong> karşı tarafta duruyor
                (toplam {pareto.summary.totalCount}).
              </p>
            )}
            <p className="mt-1 font-mono text-[10px] text-tone-4">{describeStamp(pareto.stamp)}</p>
          </>
        )}
      </Panel>

      <Panel title="YAŞLANDIRMA DAĞILIMI (ISI HARİTASI)">
        {ageingSales.result.rows.length === 0 && ageingPurchase.result.rows.length === 0 ? (
          <EmptyState>Vadesi bilinen açık kalem yok.</EmptyState>
        ) : (
          <>
            <HeatmapChart model={ageingChart} exportKey="ageing_distribution" />
            <p className="mt-1 font-mono text-[10px] text-tone-4">{describeStamp(ageingSales.stamp)}</p>
          </>
        )}
      </Panel>

      <Panel title="BÜTÇE VARYANS AYRIŞTIRMA (ŞELALE)">
        {variance.result.rows.length === 0 ? (
          <EmptyState>{variance.result.unmeasurableReason ?? "Onaylı bütçe satırı yok."}</EmptyState>
        ) : (
          <>
            <WaterfallChart model={varianceChart} exportKey="variance_decomposition" />
            <p className="mt-1 font-mono text-[10px] text-tone-4">{describeStamp(variance.stamp)}</p>
          </>
        )}
      </Panel>

      <Panel title="İŞLETME SERMAYESİ AYRIŞTIRMA">
        <TableShell>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                <th className="py-1">Bileşen</th><th className="text-right">Gün</th>
                <th>Etki</th><th>Not</th>
              </tr>
            </thead>
            <tbody>
              {wcRows.map((r) => (
                <tr key={r.key} className="border-t border-line-faint">
                  <td className="py-1">{r.label}</td>
                  {/* Unmeasurable renders as a dash with a reason — never as 0 days. */}
                  <td className="text-right font-mono">{formatMetric(r.days, "days")}</td>
                  <td className="font-mono text-tone-3">{r.sign > 0 ? "uzatır" : "kısaltır"}</td>
                  <td className="text-tone-3">{r.unmeasurableReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
        <p className="mt-2 font-mono text-[10px] text-tone-4">
          {METRICS.dio_days.description} Bu yüzden sonuç TAM nakit dönüşüm döngüsü değildir ve adı
          bunu söylüyor. {describeStamp(workingCapital.stamp)}
        </p>
      </Panel>

      <Panel
        title="AYLIK İŞLETME SERMAYESİ TRENDİ (DSO / DPO / CCC)"
        subtitle="working_capital_monthly_v · son 12 dönem konsolide alacak, borç, nakit döngüsü ve net TRY nakit akışı"
      >
        {wcMonthlySeries.length === 0 ? (
          <EmptyState>Aylık işletme sermayesi serisi için yeterli fatura veya banka hareketi bulunmuyor.</EmptyState>
        ) : (
          <>
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                    <th className="py-1">Dönem</th>
                    <th className="text-right">Açık Alacak</th>
                    <th className="text-right">Açık Borç</th>
                    <th className="text-right">Net İS (Env. Hariç)</th>
                    <th className="text-right">DSO</th>
                    <th className="text-right">DPO</th>
                    <th className="text-right">CCC (Env. Hariç)</th>
                    <th className="text-right">Net Nakit (TRY)</th>
                    <th className="text-right">Döviz Kalem</th>
                  </tr>
                </thead>
                <tbody>
                  {wcMonthlySeries.map((m) => (
                    <tr key={m.periodMonth} className="border-t border-line-faint">
                      <td className="py-1 font-mono">{m.periodMonth}</td>
                      <td className="text-right font-mono">{formatMetric(m.receivablesOpen, "currency")}</td>
                      <td className="text-right font-mono">{formatMetric(m.payablesOpen, "currency")}</td>
                      <td className="text-right font-mono">{formatMetric(m.netWorkingCapitalExInventory, "currency")}</td>
                      <td className="text-right font-mono">{formatMetric(m.dsoDays, "days")}</td>
                      <td className="text-right font-mono">{formatMetric(m.dpoDays, "days")}</td>
                      <td className="text-right font-mono font-semibold">{formatMetric(m.cashCycleExInventory, "days")}</td>
                      <td className={`text-right font-mono ${m.cashNetTry != null && m.cashNetTry < 0 ? "text-neg" : ""}`}>
                        {formatMetric(m.cashNetTry, "currency")}
                      </td>
                      <td className="text-right font-mono text-tone-3">
                        {m.foreignInvoiceCount + m.foreignCashTxCount > 0
                          ? `${m.foreignInvoiceCount} fat · ${m.foreignCashTxCount} bnk`
                          : "0"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
            <p className="mt-2 font-mono text-[10px] text-tone-4">
              Hesaplar arası transferler (own_transfer) konsolide aylık nakit giriş/çıkış toplamından düşülür; DIO envanter takibi olmadığı için hesaplanmaz.
            </p>
          </>
        )}
      </Panel>

      <Panel
        title="TARİHSEL METRİK SNAPSHOT TRENDİ"
        subtitle="metric_snapshots · son 90 gün içinde alınan anlık metrik izleri"
      >
        {SNAPSHOT_SERIES_META.every(
          (meta) =>
            (metricHistoryMap[meta.key] ?? []).filter(
              (row) => !meta.filterDimension || row.dimension_key === meta.filterDimension,
            ).length === 0,
        ) ? (
          <EmptyState>
            Henüz kaydedilmiş metrik snapshot dizisi bulunmuyor. Günlük rapor üretimi veya Sistem Durumu ekranındaki &ldquo;Metrikleri yenile&rdquo; aksiyonu ile ilk anlık görüntü alınır.
          </EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Metrik</th>
                  <th className="text-right">Son Değer</th>
                  <th className="text-right">Önceki</th>
                  <th className="text-right">Değişim</th>
                  <th className="text-right">Gözlem</th>
                  <th className="text-right">Son Snapshot</th>
                  <th className="text-right">Güven</th>
                </tr>
              </thead>
              <tbody>
                {SNAPSHOT_SERIES_META.map((meta) => {
                  const series = (metricHistoryMap[meta.key] ?? []).filter(
                    (row) => !meta.filterDimension || row.dimension_key === meta.filterDimension,
                  );
                  const latest = series.length > 0 ? series[series.length - 1] : null;
                  const prev = series.length > 1 ? series[series.length - 2] : null;
                  const delta =
                    latest?.value_numeric != null && prev?.value_numeric != null
                      ? latest.value_numeric - prev.value_numeric
                      : null;
                  return (
                    <tr key={meta.key} className="border-t border-line-faint">
                      <td className="py-1.5">{meta.label}</td>
                      <td className="text-right font-mono">
                        {latest ? formatMetric(latest.value_numeric, meta.format) : "—"}
                      </td>
                      <td className="text-right font-mono text-tone-3">
                        {prev ? formatMetric(prev.value_numeric, meta.format) : "—"}
                      </td>
                      <td className={`text-right font-mono ${delta != null && delta < 0 ? "text-neg" : ""}`}>
                        {delta != null ? formatMetric(delta, meta.format) : "—"}
                      </td>
                      <td className="text-right font-mono text-tone-3">{series.length}</td>
                      <td className="text-right font-mono text-tone-3">{latest?.snapshot_date ?? "—"}</td>
                      <td className="text-right">
                        {latest ? (
                          <Badge
                            tone={
                              latest.confidence === "high"
                                ? "green"
                                : latest.confidence === "medium"
                                  ? "amber"
                                  : "neutral"
                            }
                          >
                            {latest.confidence}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title={`DÖNEMSEL KARŞILAŞTIRMA — ${COMPARISON_LABEL.mom.toUpperCase()}`}>
        {recentPop.length === 0 ? <EmptyState>Aylık seri yok.</EmptyState> : (
          <>
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                    <th className="py-1">Ay</th><th className="text-right">Bu ay</th>
                    <th className="text-right">Önceki</th><th className="text-right">Fark</th>
                    <th className="text-right">Değişim</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPop.map((r) => (
                    <tr key={r.key} className="border-t border-line-faint">
                      <td className="py-1 font-mono">{r.key}</td>
                      <td className="text-right font-mono">{formatMetric(r.current, "currency")}</td>
                      <td className="text-right font-mono text-tone-3">{formatMetric(r.previous, "currency")}</td>
                      <td className={`text-right font-mono ${r.delta != null && r.delta < 0 ? "text-neg" : ""}`}>
                        {formatMetric(r.delta, "currency")}
                      </td>
                      {/* An unmeasurable comparison shows WHY, instead of a fabricated −100%. */}
                      <td className="text-right font-mono text-tone-2">
                        {r.changeRatio == null
                          ? <span title={r.unmeasurableReason ?? ""}>—</span>
                          : formatMetric(r.changeRatio, "percent")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
            <p className="mt-2 font-mono text-[10px] text-tone-4">
              Eksik dönem sıfır sayılmaz: önceki dönem yoksa değişim &ldquo;—&rdquo; olarak
              gösterilir, %-100 olarak değil. {describeStamp(pop.stamp)}
            </p>
          </>
        )}
      </Panel>
    </>
  );
}
