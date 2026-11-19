import { Suspense } from "react";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { money, moneyOrNull, ratioOrNull, sumMoney } from "@/lib/money";
import { istanbulDateISO } from "@/lib/reports/rules";
import {
  loadSuggestedInvoiceLinks,
  loadThresholds,
  type SuggestedInvoiceLink,
} from "@/lib/radar/engine";
import {
  dayFlagsForDate,
  loadPaymentDashboard,
  type PaymentDashboardBucket,
} from "@/lib/radar/queries";
import {
  loadPayableRunCandidates,
  loadPaymentRuns,
  type PayableRunCandidate,
  type PaymentRunSummaryRow,
} from "@/lib/payments/payment-runs";
import { formatMoney } from "@/lib/money-format";
import {
  AgingBucketsBarSvg,
  EditorialDonutChartSvg,
  PaymentHeatmapStripSvg,
  type AgingBucketItem,
  type DonutSlice,
  type HeatmapDayCell,
} from "@/components/charts/editorial-cockpit-charts";
import { ActionFeedback } from "@/components/ui/action-feedback";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { PanelSkeleton } from "@/components/ui/panel-skeleton";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import Link from "@/components/ui/app-link";
import { PaymentsChartLazy } from "@/components/charts/payments-chart-lazy";
import {
  OverdueTriageTable,
  type OverdueTriageRow,
} from "@/components/payments/overdue-triage-table";
import {
  createQuickPaymentRunAction,
  linkInvoiceToInstanceAction,
  submitPaymentRunAction,
} from "./actions";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;
const TR_MONTHS_SHORT = [
  "Oca",
  "Şub",
  "Mar",
  "Nis",
  "May",
  "Haz",
  "Tem",
  "Ağu",
  "Eyl",
  "Eki",
  "Kas",
  "Ara",
] as const;
const TR_WEEKDAYS_SHORT = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"] as const;

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);

const bucketTotal = (rows: PaymentDashboardBucket[]) =>
  sumMoney(rows.map((row) => row.knownAmount));
const bucketCount = (rows: PaymentDashboardBucket[]) =>
  rows.reduce((sum, row) => sum + row.count, 0);
const bucketUnknown = (rows: PaymentDashboardBucket[]) =>
  rows.reduce((sum, row) => sum + row.unknownCount, 0);
// PHASE 2.2 (#8): kova toplamlari SQL'de yalniz TRY (queries.ts); TRY-disi kalemler burada sayilir ve
// ekranda "n kalem TRY-disi — toplamda yok" olarak gorunur (plan §2.3). Sessiz dusme yok.
const bucketForeign = (rows: PaymentDashboardBucket[]) =>
  rows.reduce((sum, row) => sum + row.foreignCurrencyCount, 0);

function formatHeatmapDayLabel(iso: string): { dayLabel: string; weekdayShort: string } {
  const dt = new Date(`${iso}T00:00:00Z`);
  const day = dt.getUTCDate();
  const mon = TR_MONTHS_SHORT[dt.getUTCMonth()] ?? "";
  const wk = TR_WEEKDAYS_SHORT[dt.getUTCDay()] ?? "";
  return {
    dayLabel: `${day} ${mon}`,
    weekdayShort: wk,
  };
}

type PaymentsDashboardData = Awaited<ReturnType<typeof loadPaymentDashboard>>;
type PaymentsThresholds = Awaited<ReturnType<typeof loadThresholds>>;

interface PaidSummaryStats {
  paidCount: number;
  paidTryTotal: number;
  paidForeignCount: number;
}

function PaymentsDashboardView({
  today,
  dashboard,
  paidSummary,
  thresholds,
  suggestedLinks,
  paymentRuns,
  eligibleCandidates,
  bankAccounts,
  runCurrency,
  isOverdueFilter,
  triageRows,
  canLinkInvoice,
  canCreateRun,
  canUpdateRun,
  canUpdateTemplates,
}: {
  today: string;
  dashboard: PaymentsDashboardData;
  paidSummary: PaidSummaryStats;
  thresholds: PaymentsThresholds;
  suggestedLinks: SuggestedInvoiceLink[];
  paymentRuns: PaymentRunSummaryRow[];
  eligibleCandidates: PayableRunCandidate[];
  bankAccounts: Array<{ id: string; name: string; currency: string }>;
  runCurrency: "TRY" | "USD" | "EUR";
  isOverdueFilter: boolean;
  triageRows: OverdueTriageRow[];
  canLinkInvoice: boolean;
  canCreateRun: boolean;
  canUpdateRun: boolean;
  canUpdateTemplates: boolean;
}) {
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 6);
  const anchor = new Date(`${today}T00:00:00Z`);
  const month3Iso = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 3, anchor.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
  const month6Iso = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 6, anchor.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
  const month12Iso = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 12, anchor.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);

  const { buckets, flexibility: rawFlexibility, watchList, priorities } = dashboard;

  const overdueRows = buckets.filter((row) => row.status === "overdue" || row.dueDate < today);
  const forwardOpenRows = buckets.filter((row) => row.status !== "overdue" && row.dueDate >= today);

  const todayRows = forwardOpenRows.filter((row) => row.dueDate === today);
  const tomorrowRows = forwardOpenRows.filter((row) => row.dueDate === tomorrow);
  const weekRows = forwardOpenRows.filter((row) => row.dueDate >= today && row.dueDate <= weekEnd);
  const afterTodayPlannedRows = forwardOpenRows.filter((row) => row.dueDate > today);

  const overdueCount = bucketCount(overdueRows);
  const overdueKnown = bucketTotal(overdueRows);
  const todayKnown = bucketTotal(todayRows);
  const tomorrowKnown = bucketTotal(tomorrowRows);
  const weekKnown = bucketTotal(weekRows);
  const plannedFutureKnown = bucketTotal(afterTodayPlannedRows);
  const totalUnknownOpen = bucketUnknown(buckets);
  const totalForeignOpen = bucketForeign(buckets);

  const riskEnd = addDays(today, 30);
  const riskDates = [
    ...new Set(
      buckets
        .filter((row) => row.dueDate >= today && row.dueDate <= riskEnd)
        .map((row) => row.dueDate),
    ),
  ];
  // RİSKLİ GÜN KARARI = `dayFlagsForDate()` — kelimesi kelimesine.
  const risky = riskDates.filter((date) => {
    const flags = dayFlagsForDate(buckets, date, thresholds);
    return flags.cluster || flags.critical || flags.large;
  });

  /* ── 14-Day Payment Density Heatmap Strip (pure TRY + real cluster/threshold flags) ── */
  const heatmapDays: HeatmapDayCell[] = Array.from({ length: 14 }, (_, idx) => {
    const iso = addDays(today, idx);
    const dayRows = forwardOpenRows.filter((r) => r.dueDate === iso);
    const dayAmount = bucketTotal(dayRows);
    const dayCount = bucketCount(dayRows);
    const flags = dayFlagsForDate(buckets, iso, thresholds);
    const { dayLabel, weekdayShort } = formatHeatmapDayLabel(iso);

    return {
      dateIso: iso,
      dayLabel,
      weekdayShort,
      amount: dayAmount,
      formattedAmount: fmtTL(dayAmount),
      itemCount: dayCount,
      isRisky: flags.cluster || flags.critical || flags.large,
      isToday: idx === 0,
    };
  });

  /* ── 5-Column Strategic Aging / Maturity Buckets Bar (pure TRY, non-overlapping) ── */
  const rows0to3m = forwardOpenRows.filter((r) => r.dueDate > weekEnd && r.dueDate < month3Iso);
  const rows3to12m = forwardOpenRows.filter(
    (r) => r.dueDate >= month3Iso && r.dueDate < month12Iso,
  );
  const rows12Plus = forwardOpenRows.filter((r) => r.dueDate >= month12Iso);

  const amt0to3m = bucketTotal(rows0to3m);
  const amt3to12m = bucketTotal(rows3to12m);
  const amt12Plus = bucketTotal(rows12Plus);

  const agingBarBuckets: AgingBucketItem[] = [
    {
      key: "overdue",
      label: "Gecikmiş",
      amount: overdueKnown,
      formattedAmount: fmtTL(overdueKnown),
      count: overdueCount,
      tone: "neg",
    },
    {
      key: "today-7d",
      label: "Bugün & 7 Gün",
      amount: weekKnown,
      formattedAmount: fmtTL(weekKnown),
      count: bucketCount(weekRows),
      tone: "warn",
    },
    {
      key: "0-3m",
      label: "0–3 Ay",
      amount: amt0to3m,
      formattedAmount: fmtTL(amt0to3m),
      count: bucketCount(rows0to3m),
      tone: "info",
    },
    {
      key: "3-12m",
      label: "3–12 Ay",
      amount: amt3to12m,
      formattedAmount: fmtTL(amt3to12m),
      count: bucketCount(rows3to12m),
      tone: "accent",
    },
    {
      key: "12m-plus",
      label: "12+ Ay",
      amount: amt12Plus,
      formattedAmount: fmtTL(amt12Plus),
      count: bucketCount(rows12Plus),
      tone: "neutral",
    },
  ];

  /* ── Payment Portfolio Donut Ring (Gecikmiş, Bugün, Planlı Gelecek, Ödenen — pure TRY) ── */
  const paidTryClean = money(paidSummary.paidTryTotal);
  const donutSlices: DonutSlice[] = [
    {
      key: "overdue",
      label: "Gecikmiş",
      value: overdueKnown,
      formattedValue: fmtTL(overdueKnown),
      sublabel: `${overdueCount} kayıt`,
      tone: "neg",
    },
    {
      key: "today",
      label: "Bugün",
      value: todayKnown,
      formattedValue: fmtTL(todayKnown),
      sublabel: `${bucketCount(todayRows)} kayıt`,
      tone: "warn",
    },
    {
      key: "planned-future",
      label: "Planlı Gelecek",
      value: plannedFutureKnown,
      formattedValue: fmtTL(plannedFutureKnown),
      sublabel: `${bucketCount(afterTodayPlannedRows)} kayıt`,
      tone: "info",
    },
    {
      key: "paid",
      label: "Ödenen",
      value: paidTryClean,
      formattedValue: fmtTL(paidTryClean),
      sublabel: `${paidSummary.paidCount} makbuz`,
      tone: "pos",
    },
  ];
  const donutTotalTry = sumMoney(donutSlices.map((s) => s.value));

  /* ── Secondary Strategic Horizons, Overdue Ageing & Flexibility Breakdown ── */
  const horizonDefs = [
    ["overdue", "Gecikmiş", (date: string) => date < today],
    ["0-3", "0–3 ay", (date: string) => date >= today && date < month3Iso],
    ["4-6", "4–6 ay", (date: string) => date >= month3Iso && date < month6Iso],
    ["7-12", "7–12 ay", (date: string) => date >= month6Iso && date < month12Iso],
    ["13-24", "13–24 ay", (date: string) => date >= month12Iso],
  ] as const;

  const knownTotal = bucketTotal(buckets);
  const horizons = horizonDefs.map(([id, label, match]) => {
    const rows = buckets.filter((row) => match(row.dueDate));
    const perDate = new Map<string, number>();
    for (const row of rows) {
      perDate.set(row.dueDate, sumMoney([perDate.get(row.dueDate) ?? 0, row.knownAmount]));
    }
    const peakDate = [...perDate].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const knownAmount = bucketTotal(rows);
    return {
      id,
      label,
      count: bucketCount(rows),
      knownAmount,
      unknownCount: rows.reduce((sum, row) => sum + row.unknownCount, 0),
      foreignCount: bucketForeign(rows),
      share: ratioOrNull(knownAmount, knownTotal) ?? 0,
      peakDate,
    };
  });

  const ageingDefs = [
    ["1-30", "1–30 gün", 1, 30],
    ["31-90", "31–90 gün", 31, 90],
    ["91+", "91+ gün", 91, Infinity],
  ] as const;
  const ageing = ageingDefs.map(([id, label, min, max]) => {
    const rows = overdueRows.filter((row) => {
      const days = Math.floor((Date.parse(today) - Date.parse(row.dueDate)) / DAY_MS);
      return days >= min && days <= max;
    });
    const knownAmount = bucketTotal(rows);
    return {
      id,
      label,
      count: bucketCount(rows),
      knownAmount,
      share: ratioOrNull(knownAmount, overdueKnown) ?? 0,
      oldestDueDate: rows.map((row) => row.dueDate).sort()[0] ?? null,
    };
  });

  const flexLabels = {
    critical: "Kritik",
    flexible: "Esnek",
    optional: "İsteğe bağlı",
    unclassified: "Sınıflandırılmadı",
  } as const;
  const flexibility = (["critical", "flexible", "optional", "unclassified"] as const).map(
    (id) => ({
      id,
      label: flexLabels[id],
      count: 0,
      templateCount: 0,
      knownAmount: 0,
      unknownCount: 0,
      foreignCurrencyCount: 0,
      ...rawFlexibility.find((row) => row.id === id),
    }),
  );

  const pct = (value: number) =>
    `%${new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(value * 100)}`;

  const watchlistDisclosure = (
    <details className="parchment-disclosure" open={isOverdueFilter || false}>
      <summary>
        <span className="flex items-center gap-2.5">
          <span className="parchment-disclosure-chevron" aria-hidden="true">
            ▸
          </span>
          <span className="block">
            <span className="block text-[13.5px] font-semibold tracking-[-0.01em] text-tone-1">
              Kritik Ödeme İzleme Listesi ({triageRows.length || watchList.length}) &amp; Öncelikli Ödemeler ({priorities.length})
            </span>
            <span className="block max-w-[68ch] text-[11.5px] leading-[1.45] text-tone-3">
              Gecikme, kritiklik, kalan tutar ve vade önceliğine göre sıralı icra listesi
            </span>
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={overdueCount > 0 ? "red" : "neutral"}>
            {triageRows.length || watchList.length} izlenen
          </Badge>
        </span>
      </summary>

      <div className="parchment-disclosure-body space-y-3.5">
        <Panel
          title="KRİTİK ÖDEME İZLEME LİSTESİ"
          subtitle="Gecikme, kritiklik, kalan tutar ve vade önceliğine göre sıralı — çoklu seçim ve sağ çekmece destekli"
          right={
            <Link href="/payments/items" className="button-ghost px-2 py-1 text-xs">
              Tüm kalemler
            </Link>
          }
        >
          <OverdueTriageTable
            rows={triageRows}
            largeThresholdTry={thresholds.large}
            canMutateInstances={canLinkInvoice}
            canCreateRun={canCreateRun}
            canUpdateTemplates={canUpdateTemplates}
            defaultFilter={isOverdueFilter ? "overdue" : "all"}
          />
        </Panel>

        <Panel
          title="ÖNCELİKLİ ÖDEMELER"
          subtitle="Açık gecikmişler önce; ardından bugün ve yarın."
          right={
            <Link href="/payments/calendar" className="button-accent px-3 py-1.5 text-xs">
              Takvimi aç
            </Link>
          }
        >
          {priorities.length === 0 ? (
            <p className="max-w-[68ch] text-sm text-tone-3">
              Bugün için öncelikli ödeme bulunmuyor.
            </p>
          ) : (
            priorities.map((row) => (
              <div
                key={row.id}
                className="row-hover flex items-center justify-between gap-3 border-b border-line-faint py-2"
              >
                <div>
                  <div className="text-sm font-medium text-tone-1">{row.name}</div>
                  <div className="font-mono text-[10.5px] tabular-nums text-tone-3">
                    {row.due_date}
                    {row.status === "partial" ? " · kısmi ödendi" : ""}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold tabular-nums text-tone-1">
                    {row.remaining == null ? (
                      <Badge tone="amber">TUTAR EKSİK</Badge>
                    ) : (
                      formatMoney(row.remaining, row.currency ?? "TRY")
                    )}
                  </div>
                  <Badge tone={row.due_date < today ? "red" : "amber"}>
                    {row.due_date < today ? "gecikti" : "yaklaşıyor"}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </Panel>
      </div>
    </details>
  );

  return (
    <div className="space-y-3.5">
      {isOverdueFilter && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2.5 rounded-[var(--radius-md)] border px-3.5 py-2.5 text-xs"
          style={{
            borderColor: "color-mix(in srgb, var(--neg) 38%, var(--line))",
            background: "color-mix(in srgb, var(--neg) 6%, var(--surface-2))",
            color: "var(--text-1)",
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="red" dot>
              Gecikmiş Triage
            </Badge>
            <span className="leading-snug">
              <strong>Gecikmiş Ödeme Eritme Modu Aktif</strong> — Çoklu seçimle paket
              oluşturabilir, vade kaydırabilir veya satıra tıklayıp sağ çekmecede
              inceleyebilirsiniz.
            </span>
          </div>
          <Link href="/payments" className="button-ghost shrink-0 px-2.5 py-1 text-xs font-semibold">
            Tüm Görünüme Dön
          </Link>
        </div>
      )}

      {/* Row 1: Compact 4-Card KPI Row */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <KpiCard
          label="Bugün"
          value={fmtTL(todayKnown)}
          tone={bucketCount(todayRows) ? "warn" : "pos"}
          href="/payments/calendar"
          note={
            bucketForeign(todayRows) > 0
              ? `${bucketForeign(todayRows)} kalem TRY-dışı — toplamda yok`
              : bucketCount(todayRows) > 0
                ? `${bucketCount(todayRows)} açık ödeme kalemi`
                : "Bugün açık ödeme yok"
          }
        />
        <KpiCard
          label="Yarın"
          value={bucketCount(tomorrowRows) ? fmtTL(tomorrowKnown) : "Ödeme yok"}
          tone={bucketCount(tomorrowRows) ? "info" : "pos"}
          href={`/payments/calendar?date=${tomorrow}`}
          note={
            bucketForeign(tomorrowRows) > 0
              ? `${bucketForeign(tomorrowRows)} kalem TRY-dışı — toplamda yok`
              : bucketCount(tomorrowRows) > 0
                ? `${bucketCount(tomorrowRows)} planlı kalem`
                : "Yarın açık vade yok"
          }
        />
        <KpiCard
          label="7 günlük çıkış"
          value={fmtTL(weekKnown)}
          tone={weekKnown > 0 ? "warn" : "neutral"}
          href="/payments/calendar"
          note={
            bucketForeign(weekRows) > 0
              ? `${bucketForeign(weekRows)} kalem TRY-dışı — toplamda yok`
              : `${bucketCount(weekRows)} planlı kalem`
          }
        />
        <KpiCard
          label="Riskli gün"
          value={risky.length}
          tone={risky.length ? "neg" : "pos"}
          href="/payments/calendar"
          note={`30G penceresi · ≥${thresholds.clusterCount} kalem / ${fmtTL(thresholds.critical)}`}
        />
      </div>

      {isOverdueFilter && watchlistDisclosure}

      {/* Row 2: FIRST-SCREEN VISUAL COCKPIT (7 / 5 Asymmetric Split Above the Fold) */}
      <section
        aria-label="Ödeme yoğunluk ısı takvimi, vade kolonları ve portföy halkası"
        className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-12"
      >
        {/* Left (7 cols): 14-Day Payment Density Heatmap + 5-Bucket Aging Columns */}
        <div className="min-w-0 xl:col-span-7">
          <Panel
            title="Önümüzdeki 14 Gün Ödeme Yoğunluk Isı Takvimi"
            subtitle="Günlük nakit çıkış baskısı ve kümeleme riski (TRY)"
            right={
              <Link href="/payments/calendar" className="button-ghost px-2 py-1 text-[11px]">
                Tam Takvim →
              </Link>
            }
          >
            <div className="space-y-3">
              <PaymentHeatmapStripSvg
                days={heatmapDays}
                ariaLabel="Önümüzdeki 14 gün ödeme yoğunluğu ısı takvimi"
              />

              <div className="border-t border-line-faint pt-2.5">
                <div className="mb-1 flex items-center justify-between gap-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-tone-3">
                  <span>Vade &amp; Yaşlandırma Kolonları (Bilinen TRY)</span>
                  <span className="tnum font-mono text-[10px] text-tone-4">
                    Açık portföy: {fmtTL(knownTotal)}
                  </span>
                </div>
                <AgingBucketsBarSvg
                  buckets={agingBarBuckets}
                  ariaLabel="Gecikmiş, bugün ve 7 gün, 0-3 ay, 3-12 ay ve 12+ ay ödeme yaşlandırma kolonları"
                />
              </div>
            </div>
          </Panel>
        </div>

        {/* Right (5 cols): Payment Portfolio Donut Ring + Missing-Amount FIN Disclosure */}
        <div className="min-w-0 xl:col-span-5">
          <Panel
            title="Ödeme Portföy Halkası"
            subtitle="Durum ve vade ağırlığı (Bilinen TRY)"
            right={
              <Badge tone={overdueCount > 0 ? "red" : "green"} dot>
                {overdueCount} kayıt gecikmiş
              </Badge>
            }
          >
            <div className="space-y-3">
              <EditorialDonutChartSvg
                slices={donutSlices}
                centerLabel="PORTFÖY (TRY)"
                centerValue={fmtTL(donutTotalTry)}
                centerSubtext={`${bucketCount(buckets) + paidSummary.paidCount} toplam kayıt`}
                ariaLabel="Gecikmiş, bugün, planlı gelecek ve ödenen TRY ödeme portföy dağılımı"
                size={158}
              />

              {/* Explicit R10 Missing-Amount & Foreign Currency Disclosure */}
              <div
                className="rounded-[var(--radius-md)] border px-3 py-2 text-[11.5px] leading-snug"
                style={{
                  borderColor:
                    totalUnknownOpen > 0
                      ? "color-mix(in srgb, var(--warn) 36%, var(--line))"
                      : "var(--line-faint)",
                  background:
                    totalUnknownOpen > 0
                      ? "color-mix(in srgb, var(--warn) 6%, var(--surface-2))"
                      : "var(--surface-2)",
                }}
              >
                {totalUnknownOpen > 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href="/payments/missing"
                      className="tnum font-semibold text-warn underline underline-offset-2"
                    >
                      {totalUnknownOpen} açık kalemde TUTAR EKSİK →
                    </Link>
                    <span className="text-[11px] text-tone-3">Asla 0 TL varsayılmaz</span>
                  </div>
                ) : (
                  <div className="text-tone-2">
                    Açık ödeme kalemlerinde belirsiz (eksik) tutar bulunmuyor.
                  </div>
                )}

                {(totalForeignOpen > 0 || paidSummary.paidForeignCount > 0) && (
                  <div className="tnum mt-1 border-t border-line-faint pt-1 text-[11px] text-tone-3">
                    {totalForeignOpen > 0 && (
                      <span>
                        {totalForeignOpen} açık YP kalem kur çevrimi olmadan TL toplamına karıştırılmaz.
                      </span>
                    )}
                    {paidSummary.paidCount > 0 && (
                      <span>
                        {" "}
                        ·{" "}
                        <Link
                          href="/payments/history?status=paid"
                          className="underline underline-offset-2"
                        >
                          {paidSummary.paidCount} ödenen makbuz
                        </Link>
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 pt-0.5">
                <Link
                  href="/payments/items"
                  className="button-ghost px-2.5 py-1.5 text-center text-[11.5px] font-semibold"
                >
                  Tüm Ödeme Kalemleri
                </Link>
                <Link
                  href="/payments/history"
                  className="button-ghost px-2.5 py-1.5 text-center text-[11.5px] font-semibold"
                >
                  Ödeme Geçmişi
                </Link>
              </div>
            </div>
          </Panel>
        </div>
      </section>

      {/* Row 3: Interactive AnalyticsChart + Compact Assumption Disclosure + Secondary Drawers */}
      <PaymentsChartLazy />

      <div
        className="flex flex-wrap items-center gap-2 border px-3 py-2 text-[11.5px]"
        style={{
          background: "var(--surface-2)",
          borderColor: "var(--line-faint)",
          borderRadius: "var(--radius)",
          color: "var(--text-3)",
        }}
      >
        <Badge tone="amber">Varsayım (Model Sabiti)</Badge>
        <span className="leading-[1.45]">
          Riskli gün bayrakları 30G penceresi ve eşik sabitleriyle hesaplanır (büyük:{" "}
          <span className="tabular-nums">{fmtTL(thresholds.large)}</span> · kritik:{" "}
          <span className="tabular-nums">{fmtTL(thresholds.critical)}</span> · kümeleme: ≥
          <span className="tabular-nums">{thresholds.clusterCount}</span> kalem); muhasebe gerçeği değil karar eşiğidir.
        </span>
      </div>

      {/* Progressive Disclosure 1: Priority & Critical Watchlist Tables (default position when filter !== 'overdue') */}
      {!isOverdueFilter && watchlistDisclosure}

      {/* Progressive Disclosure 2: Strategic 24m Horizon, Overdue Ageing & Flexibility */}
      <details className="parchment-disclosure" open={false}>
        <summary>
          <div className="flex items-center gap-2.5">
            <span className="parchment-disclosure-chevron" aria-hidden="true">
              ▸
            </span>
            <div>
              <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-tone-1">
                Stratejik 24 Ay Ufku, Gecikme Yaşlandırması &amp; Esneklik Kırılımı
              </h2>
              <p className="max-w-[68ch] text-[11.5px] leading-[1.45] text-tone-3">
                1–30 / 31–90 / 91+ gün gecikme yaşlandırması ve kaynak bazlı kritiklik sınıfları
              </p>
            </div>
          </div>
          <Badge tone="neutral">5 vade dilimi</Badge>
        </summary>

        <div className="parchment-disclosure-body space-y-3.5">
          <Panel title="STRATEJİK ÖDEME UFKU" subtitle="Gecikmiş portföy ve bugünden ileri 24 aylık bilinen yük">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              {horizons.map((horizon) => (
                <Link
                  key={horizon.id}
                  href={`/payments?chartPeriod=${
                    horizon.id === "overdue" || horizon.id === "0-3"
                      ? "3m"
                      : horizon.id === "4-6"
                        ? "6m"
                        : horizon.id === "7-12"
                          ? "12m"
                          : "24m"
                  }`}
                  className="row-hover rounded-[var(--radius-md)] border border-line-faint p-3"
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.055em] text-tone-3">
                    {horizon.label}
                  </div>
                  <div className="mt-2 text-lg font-bold tabular-nums text-tone-1">
                    {fmtTL(horizon.knownAmount)}
                  </div>
                  <div className="tnum mt-1 flex flex-wrap gap-1 text-[11px] text-tone-3">
                    <span>{horizon.count} kayıt</span>
                    <span>· {pct(horizon.share)}</span>
                    {horizon.unknownCount > 0 && (
                      <Badge tone="amber">{horizon.unknownCount} tutar eksik</Badge>
                    )}
                    {horizon.foreignCount > 0 && (
                      <Badge tone="amber">{horizon.foreignCount} TRY-dışı · toplamda yok</Badge>
                    )}
                  </div>
                  <div className="tnum mt-2 text-[11px] text-tone-3">
                    En yoğun gün: <span className="font-mono">{horizon.peakDate ?? "—"}</span>
                  </div>
                </Link>
              ))}
            </div>
          </Panel>

          <div className="grid gap-3 xl:grid-cols-2">
            <Panel
              title="GECİKME YAŞLANDIRMASI"
              subtitle={`${overdueCount} açık gecikmiş kayıt · ${fmtTL(horizons[0]?.knownAmount ?? 0)}`}
              accent={overdueCount ? "neg" : "pos"}
            >
              <div className="grid gap-2 sm:grid-cols-3">
                {ageing
                  .filter((bucket) => bucket.count > 0)
                  .map((bucket) => (
                    <Link
                      key={bucket.id}
                      href={`/payments/calendar?age=${encodeURIComponent(bucket.id)}`}
                      className="row-hover rounded-[var(--radius-md)] border border-line-faint p-3"
                    >
                      <div className="text-xs font-semibold text-tone-1">{bucket.label}</div>
                      <div className="mt-2 text-base font-bold tabular-nums text-tone-1">
                        {fmtTL(bucket.knownAmount)}
                      </div>
                      <div className="tnum mt-1 text-[11px] text-tone-3">
                        {bucket.count} kayıt · {pct(bucket.share)}
                      </div>
                      <div className="tnum mt-1 text-[11px] text-tone-3">
                        En eski: <span className="font-mono">{bucket.oldestDueDate ?? "—"}</span>
                      </div>
                    </Link>
                  ))}
              </div>
            </Panel>

            <Panel
              title="ESNEKLİK VE KRİTİKLİK"
              subtitle="Yalnız açık kaynak öncelikleri kullanılır; sistem tahmin üretmez"
            >
              <div className="space-y-2">
                {flexibility
                  .filter((group) => group.count > 0)
                  .map((group) => (
                    <div
                      key={group.id}
                      className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-line-faint py-2"
                    >
                      <div>
                        <Badge
                          tone={
                            group.id === "critical"
                              ? "red"
                              : group.id === "optional"
                                ? "green"
                                : group.id === "flexible"
                                  ? "blue"
                                  : "neutral"
                          }
                        >
                          {group.label}
                        </Badge>
                        <span className="tnum ml-2 text-xs text-tone-3">
                          {group.templateCount} ödeme kalemi
                        </span>
                      </div>
                      <div className="text-right text-sm font-semibold tabular-nums text-tone-1">
                        {fmtTL(group.knownAmount)}
                        {group.unknownCount > 0 && (
                          <div className="text-[10.5px] font-medium text-warn">
                            {group.unknownCount} tutar eksik
                          </div>
                        )}
                        {group.foreignCurrencyCount > 0 && (
                          <div className="text-[10.5px] font-medium text-warn">
                            {group.foreignCurrencyCount} TRY-dışı · toplamda yok
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
              {flexibility.some((group) => group.id === "unclassified" && group.count > 0) && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-warn p-3 text-xs">
                  <span className="max-w-[68ch] leading-[1.45]">
                    Bu kalemlerin kaynak dosyasında esneklik bilgisi yok. Yanlış karar üretmemek için sistem otomatik tahmin yapmadı.
                  </span>
                  <Link href="/payments/items" className="button-accent px-3 py-2">
                    Kalemleri sınıflandır
                  </Link>
                </div>
              )}
            </Panel>
          </div>
        </div>
      </details>

      {/* Progressive Disclosure 3: Batch Payment Runs & Invoice Double-Count Guard */}
      <details className="parchment-disclosure" open={paymentRuns.length > 0 || suggestedLinks.length > 0}>
        <summary>
          <div className="flex items-center gap-2.5">
            <span className="parchment-disclosure-chevron" aria-hidden="true">
              ▸
            </span>
            <div>
              <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-tone-1">
                Toplu Ödeme Çalıştırma Paketleri ({paymentRuns.length}) &amp; Çift Sayım Koruması
              </h2>
              <p className="max-w-[68ch] text-[11.5px] leading-[1.45] text-tone-3">
                TRY / USD / EUR toplu ödeme emirleri, 14G minimum kasa tamponu ve fatura eşleştirmeleri
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {suggestedLinks.length > 0 && (
              <Badge tone="amber">{suggestedLinks.length} eşleşme önerisi</Badge>
            )}
            <Badge tone="neutral">{eligibleCandidates.length} IBAN-hazır aday</Badge>
          </div>
        </summary>

        <div className="parchment-disclosure-body space-y-3.5">
          {suggestedLinks.length > 0 && (
            <Panel
              title="FATURA ↔ DÜZENLİ ÖDEME ÇİFT SAYIM KORUMASI"
              subtitle="Aynı tedarikçi veya VKN ile eşleşen açık faturalar — bağlandığında 13 haftalık nakit tahmininde çift sayılmaz"
              right={<Badge tone="amber">{suggestedLinks.length} eşleşme önerisi</Badge>}
            >
              <div className="space-y-2 text-xs">
                {suggestedLinks.map((item) => (
                  <div
                    key={`${item.instanceId}:${item.invoiceId}`}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-line-faint py-2"
                  >
                    <div>
                      <div className="font-medium tabular-nums">
                        {item.paymentName} ({item.instanceDueDate} ·{" "}
                        {formatMoney(item.instanceAmount, item.currency)})
                      </div>
                      <div className="font-mono text-[11px] tabular-nums text-tone-3">
                        Fatura #{item.invoiceNo} · {item.counterpartyName} · Vade {item.invoiceDueDate} · Açık{" "}
                        {formatMoney(item.invoiceOpenAmount, item.currency)}
                      </div>
                    </div>
                    {canLinkInvoice ? (
                      <form action={linkInvoiceToInstanceAction}>
                        <input type="hidden" name="instanceId" value={item.instanceId} />
                        <input type="hidden" name="invoiceId" value={item.invoiceId} />
                        <input type="hidden" name="backTo" value="/payments" />
                        <button type="submit" className="button-ghost px-2.5 py-1 text-xs">
                          Faturaya bağla
                        </button>
                      </form>
                    ) : (
                      <Badge tone="neutral">Salt okunur</Badge>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel
            title="ÖDEME ÇALIŞTIRMA PAKETLERİ (TOPLU ÖDEME & 14G TAMPON)"
            subtitle="Çoklu para birimi (TRY / USD / EUR) toplu ödeme emirleri, IBAN doğrulama ve 14 günlük minimum kasa tamponu simülasyonu"
            right={
              <div className="flex flex-wrap items-center gap-1">
                {(["TRY", "USD", "EUR"] as const).map((ccy) => (
                  <Link
                    key={ccy}
                    href={`/payments?runCcy=${ccy}`}
                    className={
                      runCurrency === ccy
                        ? "button-accent px-2 py-1 text-xs"
                        : "button-ghost px-2 py-1 text-xs"
                    }
                  >
                    {ccy}
                  </Link>
                ))}
                <Link href="/finance/bank" className="button-ghost px-2 py-1 text-xs">
                  Banka Merkezi →
                </Link>
              </div>
            }
          >
            {paymentRuns.length > 0 ? (
              <div className="mb-4 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[11px] uppercase text-tone-3">
                      <th className="py-1">Paket Kodu</th>
                      <th>Ödeme Tarihi</th>
                      <th>Kaynak Banka</th>
                      <th>Döviz</th>
                      <th className="text-right">Toplam</th>
                      <th>Kalem</th>
                      <th>14G Min Kasa</th>
                      <th>Durum</th>
                      <th className="text-right">Aksiyon</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentRuns.map((pr) => (
                      <tr key={pr.id} className="border-t border-line-faint">
                        <td className="py-1.5 font-mono font-semibold">{pr.runCode}</td>
                        <td className="font-mono tabular-nums">{pr.plannedExecutionDate}</td>
                        <td>{pr.sourceBankName}</td>
                        <td className="font-mono">{pr.currency}</td>
                        <td className="text-right font-semibold tabular-nums">
                          {formatMoney(pr.totalAmount, pr.currency)}
                        </td>
                        <td className="font-mono tabular-nums">
                          {pr.settledItemCount}/{pr.itemCount}
                        </td>
                        <td className="tabular-nums">
                          {pr.projected14dMinCash != null
                            ? formatMoney(pr.projected14dMinCash, pr.currency)
                            : "—"}
                          {pr.breachesCashFloor && <Badge tone="red">Tampon ihlali</Badge>}
                        </td>
                        <td>
                          <Badge
                            tone={
                              pr.status === "approved" || pr.status === "settled"
                                ? "green"
                                : pr.status === "pending_approval"
                                  ? "amber"
                                  : pr.status === "cancelled"
                                    ? "red"
                                    : "neutral"
                            }
                          >
                            {pr.status}
                          </Badge>
                        </td>
                        <td className="text-right">
                          {pr.status === "draft" && canUpdateRun ? (
                            <form action={submitPaymentRunAction} className="inline">
                              <input type="hidden" name="runId" value={pr.id} />
                              <input
                                type="hidden"
                                name="backTo"
                                value={`/payments?runCcy=${runCurrency}`}
                              />
                              <button type="submit" className="button-ghost px-2 py-0.5 text-xs">
                                Onaya gönder
                              </button>
                            </form>
                          ) : (
                            <Link href="/data/approvals" className="text-tone-3 underline underline-offset-2">
                              Detay
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mb-3 max-w-[68ch] text-xs text-tone-3">
                Henüz oluşturulmuş ödeme çalıştırma paketi bulunmuyor.
              </p>
            )}

            {canCreateRun &&
              bankAccounts.filter((b) => b.currency === runCurrency).length > 0 &&
              eligibleCandidates.length > 0 && (
                <form
                  action={createQuickPaymentRunAction}
                  className="space-y-2 border-t border-line-faint pt-3 text-xs"
                >
                  <input type="hidden" name="currency" value={runCurrency} />
                  <input type="hidden" name="backTo" value={`/payments?runCcy=${runCurrency}`} />
                  <div className="text-[11px] font-semibold uppercase tracking-[0.055em] text-tone-3">
                    Hızlı {runCurrency} Ödeme Paketi Oluştur ({eligibleCandidates.length} IBAN-hazır aday)
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <select
                      name="sourceBankAccountId"
                      required
                      className="field-control px-2 py-1.5 text-xs"
                    >
                      {bankAccounts
                        .filter((b) => b.currency === runCurrency)
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name} ({b.currency})
                          </option>
                        ))}
                    </select>
                    <input
                      type="date"
                      name="plannedExecutionDate"
                      defaultValue={today}
                      required
                      className="field-control px-2 py-1.5 font-mono text-xs tabular-nums"
                    />
                    <input
                      name="notes"
                      placeholder="Paket notu (isteğe bağlı)"
                      className="field-control px-2 py-1.5 text-xs"
                    />
                  </div>
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded-[var(--radius-control)] border border-line-faint p-2">
                    {eligibleCandidates.slice(0, 12).map((cand) => (
                      <label
                        key={`${cand.targetType}:${cand.targetId}`}
                        className="flex items-center justify-between gap-2 py-0.5"
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            name="selectedTarget"
                            value={`${cand.targetType}:${cand.targetId}`}
                          />
                          <span>{cand.referenceLabel}</span>
                          <span className="text-tone-3">· {cand.partyName}</span>
                          {cand.dueDate && (
                            <span className="font-mono text-[10px] tabular-nums text-tone-3">
                              ({cand.dueDate})
                            </span>
                          )}
                        </span>
                        <span className="font-semibold tabular-nums">
                          {formatMoney(cand.openAmount, cand.currency)}
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <button type="submit" className="button-primary px-3 py-1.5 text-xs">
                      {runCurrency} Ödeme Paketi Oluştur
                    </button>
                  </div>
                </form>
              )}
          </Panel>
        </div>
      </details>
    </div>
  );
}

export default async function PaymentsSummaryPage({
  searchParams,
}: {
  searchParams?: Promise<{ filter?: string; error?: string; runCcy?: string }>;
}) {
  const denied = await requireRouteAccess("/payments");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const isOverdueFilter = sp.filter === "overdue";
  const rawCcy = (sp.runCcy ?? "TRY").toUpperCase();
  const runCurrency = rawCcy === "USD" || rawCcy === "EUR" ? rawCcy : "TRY";
  const today = istanbulDateISO();
  const anchor = new Date(`${today}T00:00:00Z`);
  const futureEnd = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 24, anchor.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);

  return (
    <>
      <PageHeader
        title="Ödemeler özeti"
        subtitle="14 günlük ödeme yoğunluk ısı takvimi, vade yaşlandırması ve portföy dağılımı."
        action={
          <span className="flex flex-wrap items-center gap-1.5">
            <Link href="/payments/calendar" className="button-ghost px-2.5 py-1.5 text-xs">
              Takvim
            </Link>
            <Link href="/payments/new" className="button-accent px-3 py-1.5 text-xs">
              + Ödeme Ekle
            </Link>
          </span>
        }
      />
      <ActionFeedback error={sp.error} />
      <Suspense fallback={<PanelSkeleton title="ÖDEMELER ÖZETİ" subtitle="Yükleniyor" rows={5} />}>
        <PaymentsDashboardContent
          today={today}
          futureEnd={futureEnd}
          runCurrency={runCurrency}
          isOverdueFilter={isOverdueFilter}
        />
      </Suspense>
    </>
  );
}

async function PaymentsDashboardContent({
  today,
  futureEnd,
  runCurrency,
  isOverdueFilter,
}: {
  today: string;
  futureEnd: string;
  runCurrency: "TRY" | "USD" | "EUR";
  isOverdueFilter: boolean;
}) {
  const pool = getPool();
  const session = await requireSession();
  const triageLimit = isOverdueFilter ? 150 : 8;
  const [
    dashboard,
    thresholds,
    suggestedLinks,
    paymentRuns,
    runCandidates,
    bankAcctRes,
    paidStatsRes,
    triageRes,
  ] = await Promise.all([
    loadPaymentDashboard(pool, today, futureEnd),
    loadThresholds(pool),
    loadSuggestedInvoiceLinks(pool, 10),
    loadPaymentRuns(pool, 8),
    loadPayableRunCandidates(pool, runCurrency, 20).catch(() => [] as PayableRunCandidate[]),
    pool
      .query<{ id: string; name: string; currency: string }>(
        `select ba.cash_account_id::text as id, ca.name, coalesce(ca.currency, 'TRY') as currency
           from public.bank_accounts ba
           join public.cash_accounts ca on ca.id = ba.cash_account_id
          where ca.is_active = true
          order by ca.name`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query<{
        paid_count: number;
        paid_try_total: string;
        paid_foreign_count: number;
      }>(
        `select
           count(*) filter (where status = 'paid' and cancelled_at is null)::int as paid_count,
           coalesce(
             sum(
               case
                 when status = 'paid' then coalesce(paid_amount, amount)
                 when status = 'partial' then paid_amount
                 else null
               end
             ) filter (
               where cancelled_at is null
                 and currency = 'TRY'
                 and status in ('paid', 'partial')
             ),
             0
           )::text as paid_try_total,
           count(*) filter (where status = 'paid' and cancelled_at is null and currency <> 'TRY')::int as paid_foreign_count
         from public.payment_instances
         where due_date <= $1::date`,
        [futureEnd],
      )
      .catch(() => ({
        rows: [{ paid_count: 0, paid_try_total: "0", paid_foreign_count: 0 }],
      })),
    pool
      .query<{
        id: string;
        payment_id: string | null;
        name: string;
        category: string | null;
        provider: string | null;
        owner: string | null;
        cost_center: string | null;
        from_source: boolean;
        due_date: string;
        status: string;
        currency: string;
        amount: string | null;
        paid_amount: string | null;
        remaining: string | null;
        days_overdue: number;
        risk_level: string | null;
        risk_reasons: string[] | null;
        flexibility_class: string | null;
        decision_flexibility: string;
        note: string | null;
      }>(
        `select i.id::text as id,
                i.payment_id::text as payment_id,
                coalesce(p.name, '(silinmiş kalem)') as name,
                c.name as category,
                pr.name as provider,
                ow.name as owner,
                cc.name as cost_center,
                (i.source_row_id is not null or p.source_row_id is not null) as from_source,
                to_char(i.due_date, 'YYYY-MM-DD') as due_date,
                i.status,
                coalesce(i.currency, 'TRY') as currency,
                i.amount::text as amount,
                i.paid_amount::text as paid_amount,
                case when i.amount is null then null else greatest(i.amount - coalesce(i.paid_amount, 0), 0)::text end as remaining,
                greatest(0, ($1::date - i.due_date))::int as days_overdue,
                i.risk_level,
                i.risk_reasons,
                p.flexibility_class,
                case
                  when p.flexibility_class in ('critical', 'flexible', 'optional') then p.flexibility_class
                  when p.priority in ('critical', 'high') or i.risk_level = 'critical' then 'critical'
                  when p.priority = 'low' then 'optional'
                  else 'unclassified'
                end as decision_flexibility,
                i.note
           from public.payment_instances i
           left join public.payments p on p.id = i.payment_id
           left join public.categories c on c.id = p.category_id
           left join public.parties pr on pr.id = p.provider_party_id
           left join public.parties ow on ow.id = p.owner_party_id
           left join public.cost_centers cc on cc.id = p.cost_center_id
          where i.due_date <= $2::date
            and (i.due_date >= $1::date or i.status in ('unpaid', 'partial', 'planned', 'late'))
            and i.status in ('unpaid', 'partial', 'planned', 'late', 'unknown')
            and i.status <> 'cancelled'
            and i.cancelled_at is null
          order by greatest(0, ($1::date - i.due_date)) desc,
                   (
                     case
                       when p.flexibility_class in ('critical', 'flexible', 'optional') then p.flexibility_class
                       when p.priority in ('critical', 'high') or i.risk_level = 'critical' then 'critical'
                       when p.priority = 'low' then 'optional'
                       else 'unclassified'
                     end = 'critical'
                   ) desc,
                   (case when i.amount is null then null else greatest(i.amount - coalesce(i.paid_amount, 0), 0) end) desc nulls last
          limit $3::int`,
        [today, futureEnd, triageLimit],
      )
      .catch(() => null),
  ]);

  const paidRow = paidStatsRes.rows[0];
  const paidSummary: PaidSummaryStats = {
    paidCount: Number(paidRow?.paid_count ?? 0),
    paidTryTotal: moneyOrNull(paidRow?.paid_try_total ?? null) ?? 0,
    paidForeignCount: Number(paidRow?.paid_foreign_count ?? 0),
  };

  const triageRows: OverdueTriageRow[] = triageRes
    ? triageRes.rows.map((r) => ({
        id: r.id,
        paymentId: r.payment_id,
        name: r.name,
        category: r.category,
        provider: r.provider,
        owner: r.owner,
        costCenter: r.cost_center,
        fromSource: Boolean(r.from_source),
        dueDate: r.due_date,
        status: r.status,
        currency: r.currency,
        amount: moneyOrNull(r.amount),
        paidAmount: moneyOrNull(r.paid_amount),
        remaining: moneyOrNull(r.remaining),
        daysOverdue: Number(r.days_overdue ?? 0),
        riskLevel: r.risk_level,
        riskReasons: Array.isArray(r.risk_reasons) ? r.risk_reasons : [],
        flexibilityClass:
          r.flexibility_class === "critical" ||
          r.flexibility_class === "flexible" ||
          r.flexibility_class === "optional"
            ? r.flexibility_class
            : null,
        decisionFlexibility:
          r.decision_flexibility === "critical" ||
          r.decision_flexibility === "flexible" ||
          r.decision_flexibility === "optional"
            ? r.decision_flexibility
            : "unclassified",
        note: r.note,
      }))
    : dashboard.watchList.map((w) => ({
        id: w.id,
        paymentId: w.payment_id,
        name: w.name,
        category: w.category ?? null,
        provider: null,
        owner: null,
        costCenter: null,
        fromSource: Boolean(w.source_linked),
        dueDate: w.due_date,
        status: w.status,
        currency: w.currency ?? "TRY",
        amount: w.amount,
        paidAmount: w.paid_amount,
        remaining: w.remaining,
        daysOverdue: w.daysOverdue,
        riskLevel: w.risk_level,
        riskReasons: Array.isArray(w.risk_reasons) ? w.risk_reasons : [],
        flexibilityClass: w.flexibility ?? null,
        decisionFlexibility: w.decisionFlexibility,
        note: w.note,
      }));

  return (
    <PaymentsDashboardView
      today={today}
      dashboard={dashboard}
      paidSummary={paidSummary}
      thresholds={thresholds}
      suggestedLinks={suggestedLinks}
      paymentRuns={paymentRuns}
      eligibleCandidates={runCandidates.filter(
        (c) => c.eligibleForRun && Boolean(c.beneficiaryIban),
      )}
      bankAccounts={bankAcctRes.rows}
      runCurrency={runCurrency}
      isOverdueFilter={isOverdueFilter}
      triageRows={triageRows}
      canLinkInvoice={can(session.role, "payment_instances", "update")}
      canCreateRun={can(session.role, "payment_runs", "insert")}
      canUpdateRun={can(session.role, "payment_runs", "update")}
      canUpdateTemplates={can(session.role, "payments", "update")}
    />
  );
}
