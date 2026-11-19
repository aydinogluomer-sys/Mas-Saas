import Link from "@/components/ui/app-link";
import { getPool } from "@/lib/db";
import { istanbulDateISO } from "@/lib/reports/rules";
import { ANALYSES } from "@/lib/analytics/registry";
import {
  runAgeingDistribution,
  runParetoConcentration,
  runVarianceDecomposition,
} from "@/lib/analytics/engine";
import { loadInsightsHubBundle } from "@/lib/analytics/insights-engine";
import { loadMetricHistory, type MetricSnapshotRow } from "@/lib/analytics/snapshots";
import { heatmapModel, treemapModel, waterfallModel } from "@/lib/analytics/chart-types";
import { formatMetric } from "@/lib/analytics/analyses";
import { describeStamp } from "@/lib/analytics/reproducibility";
import { COMPARISON_LABEL, type PeriodComparison } from "@/lib/analytics/periods";
import { intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { HeatmapChart, TreemapChart, WaterfallChart } from "@/components/charts/advanced-charts";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
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

const COMPARISON_MODES: PeriodComparison[] = ["mom", "qoq", "yoy"];

interface AnalysisPageProps {
  searchParams?: Promise<{ comparison?: string }>;
}

export default async function AnalysisPage({ searchParams }: AnalysisPageProps) {
  const denied = await requireRouteAccess("/insights/analysis");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const comparison: PeriodComparison =
    sp.comparison === "qoq" || sp.comparison === "yoy" ? sp.comparison : "mom";

  const pool = getPool();
  const asOf = istanbulDateISO();

  const [
    insights,
    variance,
    pareto,
    ageingSales,
    ageingPurchase,
    wcMonthlySeries,
    histWorstClosing,
    histMaturityOutflow,
    histLoanRemaining,
    histDecisionConfidence,
  ] = await Promise.all([
    loadInsightsHubBundle(pool, asOf, comparison),
    runVarianceDecomposition(pool, asOf),
    runParetoConcentration(pool, asOf),
    runAgeingDistribution(pool, "sales", asOf),
    runAgeingDistribution(pool, "purchase", asOf),
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

  const { cfoBridge, liveWc, rollingTrendChart, popRows } = insights;

  const varianceChart = waterfallModel({
    title: "Varyans ayrıştırma",
    description: "Bütçe sapmasına en çok katkı veren kalemler",
    format: "currency",
    asOf,
    sourceLabel: "budget_vs_actual",
    steps: variance.result.rows.slice(0, 10).map((r) => ({
      key: r.key,
      label: r.label,
      value: r.value,
      kind: r.value >= 0 ? ("increase" as const) : ("decrease" as const),
    })),
    unknownCount: variance.result.unknownCount,
  });

  const paretoChart = treemapModel({
    title: "Alacak yoğunlaşması",
    description: "Açık alacağın karşı taraflara dağılımı",
    format: "currency",
    asOf,
    sourceLabel: "invoices + parties",
    items: pareto.result.rows.map((r) => ({ key: r.key, label: r.label, value: r.value })),
    maxTiles: 12,
  });

  const ageingChart = heatmapModel({
    title: "Yaşlandırma dağılımı",
    description: "Açık alacak ve borcun vade kovalarına dağılımı",
    format: "currency",
    asOf,
    sourceLabel: "invoices",
    rows: [
      { key: "sales", label: "Alacak" },
      { key: "purchase", label: "Borç" },
    ],
    columns: ageingSales.result.rows.map((r) => ({ key: r.bucketKey, label: r.bucketLabel })),
    values: [
      ...ageingSales.result.rows.map((r) => ({ rowKey: "sales", columnKey: r.bucketKey, value: r.amount })),
      ...ageingPurchase.result.rows.map((r) => ({ rowKey: "purchase", columnKey: r.bucketKey, value: r.amount })),
    ],
  });

  const hasFullCcc = liveWc.cashConversionCycleDays != null;
  const cccDisplay = hasFullCcc
    ? formatMetric(liveWc.cashConversionCycleDays, "days")
    : formatMetric(liveWc.cycleExcludingInventoryDays, "days");
  const cccNote = hasFullCcc
    ? `Tam CCC = DSO (${formatMetric(liveWc.dsoDays, "days")}) + DIO (${formatMetric(liveWc.dioDays, "days")}) − DPO (${formatMetric(liveWc.dpoDays, "days")})`
    : `Envanter hariç (DSO − DPO) · ${liveWc.dioUnmeasurableReason ?? "DIO ölçülemez"}`;

  const hasRollingData = rollingTrendChart.series.some((s) => s.points.some((p) => p.value != null));

  return (
    <>
      <PageHeader
        title="Analiz Merkezi"
        subtitle={`${Object.keys(ANALYSES).length} adlandırılmış analiz · 11 adımlı CFO nakit köprüsü, MoM/QoQ/YoY varyans ve canlı CCC`}
        meta={<Badge tone="green" dot>deterministik</Badge>}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <KeyStat
          label={hasFullCcc ? "Tam Nakit Döngüsü (CCC)" : "Nakit Döngüsü (Env. Hariç)"}
          value={cccDisplay}
          tone={hasFullCcc ? "pos" : "neutral"}
          sub={cccNote}
        />
        <KeyStat
          label="Stok Devir Süresi (DIO)"
          value={formatMetric(liveWc.dioDays, "days")}
          tone={liveWc.dioDays != null ? "pos" : "neutral"}
          sub={
            liveWc.dioDays != null
              ? `TDHP 150-157 Stok: ${liveWc.inventoryBalanceTry == null ? "—" : fmtTL(liveWc.inventoryBalanceTry)}`
              : liveWc.dioUnmeasurableReason ?? "TDHP 150-153 stok bakiyesi bekleniyor"
          }
        />
        <KeyStat
          label="Net İşletme Nakit Akışı (90G)"
          value={cfoBridge.netOperatingCashTry == null ? "—" : fmtTL(cfoBridge.netOperatingCashTry)}
          tone={(cfoBridge.netOperatingCashTry ?? 0) >= 0 ? "pos" : "neg"}
          sub={
            cfoBridge.ebitdaCashConversionPct != null
              ? `FAVÖK Nakit Dönüşümü: %${cfoBridge.ebitdaCashConversionPct}`
              : cfoBridge.managementEbitdaTry != null
                ? `TDHP FAVÖK: ${fmtTL(cfoBridge.managementEbitdaTry)}`
                : "90 günlük konsolide nakit akışı"
          }
        />
        <KeyStat
          label="Alacak Yoğunlaşması (Pareto)"
          value={pareto.summary ? `${pareto.summary.vitalFewCount} / ${pareto.summary.totalCount}` : "—"}
          tone={pareto.summary && pareto.summary.vitalFewCount <= 3 ? "warn" : "neutral"}
          sub={pareto.summary ? `açık alacağın %${Math.round(pareto.summary.threshold * 100)}'i` : "veri yok"}
        />
        <KeyStat
          label="Bütçe Sapması Olan Kalem"
          value={String(variance.result.rows.length)}
          tone={variance.result.rows.length > 0 ? "warn" : "pos"}
          sub={`${variance.result.unknownCount} kalem eksik veri`}
        />
      </div>

      <Panel
        title="11 ADIMLI CFO NAKİT VE İŞLETME AKIŞI KÖPRÜSÜ (ŞELALE)"
        subtitle={`${cfoBridge.windowStartISO} → ${cfoBridge.windowEndISO} · Açılış Kasası → Tahsilat → POS → Tedarikçi → Maaş/SGK → Vergi → İşletme Sonrası Kasa → CAPEX → Kredi Servisi → Kur → Kapanış`}
        right={
          cfoBridge.reconciles != null ? (
            <Badge tone={cfoBridge.reconciles ? "green" : "red"} dot>
              {cfoBridge.reconciles ? "kuruş mutabakatı tam" : `fark: ${fmtTL(cfoBridge.difference)}`}
            </Badge>
          ) : undefined
        }
      >
        {cfoBridge.steps.length === 0 ? (
          <EmptyState>{cfoBridge.unmeasurableReason ?? "Nakit köprüsü için kasa/banka verisi yok."}</EmptyState>
        ) : (
          <>
            <WaterfallChart model={cfoBridge.chart} exportKey="cfo_11_step_cash_bridge" />
            <div className="mt-3 overflow-x-auto border-t border-line pt-2">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                    <th className="py-1">Adım</th>
                    <th className="text-right">Katkı / Seviye (TL)</th>
                    <th className="text-right">Kümülatif Kasa (TL)</th>
                    <th className="text-right">Tür</th>
                  </tr>
                </thead>
                <tbody>
                  {cfoBridge.steps.map((s) => (
                    <tr key={s.key} className="border-t border-line-faint">
                      <td className="py-1 font-medium">{s.label}</td>
                      <td
                        className={`text-right font-mono ${
                          s.kind === "decrease" ? "text-neg" : s.kind === "increase" ? "text-pos" : "font-semibold"
                        }`}
                      >
                        {fmtTL(s.value)}
                      </td>
                      <td className="text-right font-mono text-tone-2">{fmtTL(s.runningTotal)}</td>
                      <td className="text-right font-mono text-[10px] uppercase text-tone-3">
                        {s.kind === "start"
                          ? "Açılış"
                          : s.kind === "end"
                            ? "Ara/Son Bakiye"
                            : s.kind === "increase"
                              ? "Giriş (+)"
                              : "Çıkış (-)"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cfoBridge.managementEbitdaTry != null ? (
              <p className="mt-2 font-mono text-[11px] text-tone-2">
                TDHP Yönetim FAVÖK: <strong>{fmtTL(cfoBridge.managementEbitdaTry)}</strong> · Dönem Net Kâr:{" "}
                <strong>{cfoBridge.netIncomeTry == null ? "—" : fmtTL(cfoBridge.netIncomeTry)}</strong> · Net İşletme Nakit Akışı:{" "}
                <strong>{cfoBridge.netOperatingCashTry == null ? "—" : fmtTL(cfoBridge.netOperatingCashTry)}</strong>
              </p>
            ) : null}
          </>
        )}
      </Panel>

      <Panel
        title="6 AYLIK HAREKETLİ NAKİT AKIŞI TRENDİ (ROLLING TREND)"
        subtitle="Aylık konsolide tahsilat, ödeme ve 6 aylık hareketli ortalama net nakit üretim eğrisi"
      >
        {!hasRollingData ? (
          <EmptyState>6 aylık hareketli trend için yeterli aylık nakit akışı gözlemi bulunmuyor.</EmptyState>
        ) : (
          <AnalyticsChart model={rollingTrendChart} kind="line" defaultPeriod="6m" />
        )}
      </Panel>

      <Panel
        title="CANLI İŞLETME SERMAYESİ AYRIŞTIRMA (DSO + DIO − DPO = CCC)"
        subtitle="working_capital_metrics · alacak, stok ve borç devir süreleri"
      >
        <TableShell>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                <th className="py-1">Bileşen</th>
                <th className="text-right">Gün</th>
                <th className="text-right">Bakiye (TL)</th>
                <th>Etki</th>
                <th>Metodoloji / Durum</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-line-faint">
                <td className="py-1.5 font-medium">Alacak Tahsil Süresi (DSO)</td>
                <td className="text-right font-mono">{formatMetric(liveWc.dsoDays, "days")}</td>
                <td className="text-right font-mono">{formatMetric(liveWc.receivablesOpenTry, "currency")}</td>
                <td className="font-mono text-tone-3">+ uzatır</td>
                <td className="text-tone-3">Açık satış faturaları / son 365g satışlar × 365</td>
              </tr>
              <tr className="border-t border-line-faint">
                <td className="py-1.5 font-medium">Stokta Kalma Süresi (DIO)</td>
                <td className="text-right font-mono">{formatMetric(liveWc.dioDays, "days")}</td>
                <td className="text-right font-mono">{formatMetric(liveWc.inventoryBalanceTry, "currency")}</td>
                <td className="font-mono text-tone-3">+ uzatır</td>
                <td className="text-tone-3">
                  {liveWc.dioDays != null
                    ? "TDHP 150-157 stok bakiyesi / SMM (620-622) × 365"
                    : liveWc.dioUnmeasurableReason ?? "Stok veya SMM verisi yok"}
                </td>
              </tr>
              <tr className="border-t border-line-faint">
                <td className="py-1.5 font-medium">Ticari Borç Ödeme Süresi (DPO)</td>
                <td className="text-right font-mono">{formatMetric(liveWc.dpoDays, "days")}</td>
                <td className="text-right font-mono">{formatMetric(liveWc.payablesOpenTry, "currency")}</td>
                <td className="font-mono text-tone-3">− kısaltır</td>
                <td className="text-tone-3">Açık alış faturaları / son 365g alışlar × 365</td>
              </tr>
              <tr className="border-t border-line font-semibold">
                <td className="py-1.5">Tam Nakit Dönüşüm Döngüsü (CCC = DSO + DIO − DPO)</td>
                <td className="text-right font-mono">{formatMetric(liveWc.cashConversionCycleDays, "days")}</td>
                <td className="text-right font-mono">—</td>
                <td className="font-mono text-tone-2">net döngü</td>
                <td className="text-tone-3">
                  {liveWc.cashConversionCycleDays != null
                    ? "Tam stok dahil CCC aktif"
                    : `Env. hariç (DSO − DPO): ${formatMetric(liveWc.cycleExcludingInventoryDays, "days")} · ${liveWc.cccUnmeasurableReason ?? "DIO bekleniyor"}`}
                </td>
              </tr>
            </tbody>
          </table>
        </TableShell>
      </Panel>

      <Panel
        title={`DÖNEMSEL VARYANS KARŞILAŞTIRMA — ${COMPARISON_LABEL[comparison].toUpperCase()}`}
        subtitle={`Kaynak: ${insights.popSourceLabel} · MoM (Aylık), QoQ (Çeyreklik) ve YoY (Yıllık) karşılaştırma`}
        right={
          <div className="flex items-center gap-1">
            {COMPARISON_MODES.map((m) => (
              <Link
                key={m}
                href={`/insights/analysis?comparison=${m}`}
                style={{
                  background: comparison === m ? "var(--text-1)" : "var(--surface-2)",
                  color: comparison === m ? "var(--surface-1)" : "var(--text-1)",
                  border: "1px solid var(--line)",
                }}
                className="px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider"
              >
                {m.toUpperCase()}
              </Link>
            ))}
          </div>
        }
      >
        {popRows.length === 0 ? (
          <EmptyState>Aylık seri bulunmuyor.</EmptyState>
        ) : (
          <>
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                    <th className="py-1">Dönem</th>
                    <th className="text-right">Cari Dönem</th>
                    <th className="text-right">Karşılaştırma Bazı</th>
                    <th className="text-right">Mutlak Fark (Δ)</th>
                    <th className="text-right">Yüzde Değişim (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {popRows.map((r) => (
                    <tr key={r.key} className="border-t border-line-faint">
                      <td className="py-1 font-mono">{r.key}</td>
                      <td className="text-right font-mono">{formatMetric(r.current, "currency")}</td>
                      <td className="text-right font-mono text-tone-3">{formatMetric(r.previous, "currency")}</td>
                      <td
                        className={`text-right font-mono ${
                          r.delta != null && r.delta < 0
                            ? "text-neg"
                            : r.delta != null && r.delta > 0
                              ? "text-pos"
                              : ""
                        }`}
                      >
                        {formatMetric(r.delta, "currency")}
                      </td>
                      <td className="text-right font-mono text-tone-2">
                        {r.changeRatio == null ? (
                          <span title={r.unmeasurableReason ?? ""}>—</span>
                        ) : (
                          formatMetric(r.changeRatio, "percent")
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
            <p className="mt-2 font-mono text-[10px] text-tone-4">
              Eksik dönem sıfır sayılmaz: baz dönem yoksa değişim &ldquo;—&rdquo; olarak gösterilir, %-100 uydurulmaz.
            </p>
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

      <Panel
        title="AYLIK İŞLETME SERMAYESİ TRENDİ (DSO / DIO / DPO / CCC)"
        subtitle="working_capital_monthly_v · son 12 dönem konsolide alacak, borç, nakit döngüsü ve net TRY nakit akışı"
      >
        {wcMonthlySeries.length === 0 ? (
          <EmptyState>Aylık işletme sermayesi serisi için yeterli fatura veya banka hareketi bulunmuyor.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Dönem</th>
                  <th className="text-right">Açık Alacak</th>
                  <th className="text-right">Açık Borç</th>
                  <th className="text-right">Net İS (Env. Hariç)</th>
                  <th className="text-right">DSO</th>
                  <th className="text-right">DIO</th>
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
                    <td className="text-right font-mono">{formatMetric(m.dioDays, "days")}</td>
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
    </>
  );
}
