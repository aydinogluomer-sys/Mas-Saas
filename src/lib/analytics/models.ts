import type { MaturityItem } from "@/lib/financing/rules";
import type { InstanceRow } from "@/lib/radar/queries";
import type { CashMonth } from "@/lib/radar/rules";
import type { ChartModel, ChartPoint, PaymentPressurePointMeta } from "./chart";
import { isComparableCurrency } from "@/lib/currency-policy";
import { sumMoney } from "@/lib/money";

const monthLabel = (iso: string) => iso.slice(0, 7);
const point = (key: string, label: string, value: number | null, href?: string): ChartPoint => ({ key, label, value, href });

export function cashTrendModel(months: CashMonth[], asOf: string): ChartModel {
  return {
    title: "Kasa eğilimi",
    description: "Açılış ve kapanış bakiyeleri; negatif bölge nakit açığını gösterir.",
    asOf, timeDirection: "forward", summaryMode: "endpoint", sourceLabel: "Aylık nakit akışı", sourceHref: "/data/sources",
    unknownCount: months.filter((m) => m.opening == null || m.closing == null).length,
    annotations: [],
    series: [
      { id: "opening", label: "Açılış", tone: "neutral", format: "currency", dashed: true, points: months.map((m) => point(monthLabel(m.monthStart), monthLabel(m.monthStart), m.opening, `/cashflow/monthly?month=${monthLabel(m.monthStart)}`)) },
      { id: "closing", label: "Kapanış", tone: "info", format: "currency", points: months.map((m) => point(monthLabel(m.monthStart), monthLabel(m.monthStart), m.closing, `/cashflow/monthly?month=${monthLabel(m.monthStart)}`)) },
    ],
  };
}

export function incomeExpenseModel(months: CashMonth[], asOf: string): ChartModel {
  return {
    title: "Gelir, gider ve net hareket",
    description: "Bilinen aylık gelir ve giderler; net hareket yalnız iki tutar da biliniyorsa hesaplanır.",
    asOf, timeDirection: "forward", summaryMode: "sum", sourceLabel: "Aylık nakit akışı", sourceHref: "/data/sources",
    unknownCount: months.filter((m) => m.income == null || m.expense == null).length,
    annotations: [],
    series: [
      { id: "income", label: "Gelir", tone: "positive", format: "currency", points: months.map((m) => point(monthLabel(m.monthStart), monthLabel(m.monthStart), m.income, `/cashflow/monthly?month=${monthLabel(m.monthStart)}`)) },
      { id: "expense", label: "Gider", tone: "negative", format: "currency", points: months.map((m) => point(monthLabel(m.monthStart), monthLabel(m.monthStart), m.expense, `/cashflow/monthly?month=${monthLabel(m.monthStart)}`)) },
      { id: "net", label: "Net hareket", tone: "info", format: "currency", points: months.map((m) => point(monthLabel(m.monthStart), monthLabel(m.monthStart), m.income != null && m.expense != null ? m.income - m.expense : null, `/cashflow/monthly?month=${monthLabel(m.monthStart)}`)) },
    ],
  };
}

type PressureStatus = "overdue" | "partial" | "planned";
type Flexibility = "critical" | "flexible" | "optional" | "unclassified";

const OPEN_PAYMENT_STATUSES = new Set(["unpaid", "partial", "planned", "late", "unknown"]);
const remainingPayment = (row: InstanceRow) => row.amount == null ? null : Math.max(0, row.amount - (row.paid_amount ?? 0));
const pressureStatus = (row: InstanceRow, asOf: string): PressureStatus | null => {
  if (!OPEN_PAYMENT_STATUSES.has(row.status)) return null;
  if (row.due_date < asOf) return "overdue";
  if (row.status === "partial") return "partial";
  return "planned";
};
const flexibilityOf = (row: InstanceRow): Flexibility => {
  if (row.flexibility === "critical" || row.flexibility === "flexible" || row.flexibility === "optional") return row.flexibility;
  if (row.priority === "critical" || row.priority === "high" || row.risk_level === "critical") return "critical";
  if (row.priority === "low") return "optional";
  return "unclassified";
};
const addCalendarMonths = (iso: string, months: number) => {
  const date = new Date(`${iso}T00:00:00Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate())).toISOString().slice(0, 10);
};

export interface PaymentPressureHorizon {
  id: "overdue" | "0-3" | "4-6" | "7-12" | "13-24";
  label: string;
  count: number;
  knownAmount: number;
  unknownCount: number;
  /** PHASE 2.2: TRY-dışı kalem — knownAmount'a girmez. */
  foreignCurrencyCount: number;
  share: number;
  peakDate: string | null;
}

export interface PaymentAgeingBucket {
  id: "1-30" | "31-90" | "91+";
  label: string;
  count: number;
  knownAmount: number;
  unknownCount: number;
  foreignCurrencyCount: number;
  oldestDueDate: string | null;
  share: number;
}

export interface PaymentPressureAnalysis {
  knownTotal: number;
  unknownCount: number;
  /** PHASE 2.2 (#13): aktif kalemler içinde TRY-dışı olanlar — hiçbir toplama girmedi. */
  foreignCurrencyCount: number;
  recordCount: number;
  horizons: PaymentPressureHorizon[];
  ageing: PaymentAgeingBucket[];
  flexibility: Array<{ id: Flexibility; label: string; count: number; templateCount: number; knownAmount: number; unknownCount: number; foreignCurrencyCount: number }>;
  watchList: Array<InstanceRow & { remaining: number | null; daysOverdue: number; decisionFlexibility: Flexibility }>;
}

export function prioritizePayments(rows: InstanceRow[], asOf: string, limit = 5): InstanceRow[] {
  const tomorrow = new Date(Date.parse(asOf) + 86400000).toISOString().slice(0, 10);
  return rows.filter((row) => pressureStatus(row, asOf) != null && row.due_date <= tomorrow)
    .sort((a, b) => {
      const overdueDelta = Number(b.due_date < asOf) - Number(a.due_date < asOf);
      if (overdueDelta) return overdueDelta;
      if (a.due_date !== b.due_date) return a.due_date.localeCompare(b.due_date);
      const criticalDelta = Number(flexibilityOf(b) === "critical") - Number(flexibilityOf(a) === "critical");
      if (criticalDelta) return criticalDelta;
      // PHASE 2.2 (T1-b): unsupported_currency = eşik değerlendirilemedi; rules.ts merdiveniyle aynı sıra.
      const riskRank: Record<string, number> = { critical: 5, high: 4, unsupported_currency: 3, medium: 2, low: 1, none: 0 };
      const riskDelta = (riskRank[b.risk_level] ?? 0) - (riskRank[a.risk_level] ?? 0);
      return riskDelta || (remainingPayment(b) ?? -1) - (remainingPayment(a) ?? -1);
    }).slice(0, limit);
}

// PHASE 2.2 (#13): toplamlar yalniz TRY; TRY-disi (ya da para birimi bilinmeyen) kalemin kalani
// toplama girmez, `foreignCurrencyCount` ile sayilir. Sayimlar (count) para biriminden bagimsiz.
const tryRemaining = (row: InstanceRow): number | null =>
  isComparableCurrency(row.currency) ? remainingPayment(row) : null;
const sumTryRemaining = (list: InstanceRow[]): number =>
  sumMoney(list.map(tryRemaining).filter((v): v is number => v != null));

export function analyzePaymentPressure(rows: InstanceRow[], asOf: string): PaymentPressureAnalysis {
  const active = rows.filter((row) => pressureStatus(row, asOf) != null);
  const knownTotal = sumTryRemaining(active);
  const dateTotal = (list: InstanceRow[]) => {
    const totals = new Map<string, number>();
    for (const row of list) if (tryRemaining(row) != null) totals.set(row.due_date, (totals.get(row.due_date) ?? 0) + tryRemaining(row)!);
    return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const h3 = addCalendarMonths(asOf, 3), h6 = addCalendarMonths(asOf, 6), h12 = addCalendarMonths(asOf, 12), h24 = addCalendarMonths(asOf, 24);
  const horizonDefs: Array<[PaymentPressureHorizon["id"], string, (row: InstanceRow) => boolean]> = [
    ["overdue", "Gecikmiş portföy", (row) => row.due_date < asOf],
    ["0-3", "0–3 ay · Kısa vade", (row) => row.due_date >= asOf && row.due_date < h3],
    ["4-6", "4–6 ay · Orta vade", (row) => row.due_date >= h3 && row.due_date < h6],
    ["7-12", "7–12 ay · Stratejik vade", (row) => row.due_date >= h6 && row.due_date < h12],
    ["13-24", "13–24 ay · Uzun dönem", (row) => row.due_date >= h12 && row.due_date < h24],
  ];
  const horizons = horizonDefs.map(([id, label, match]) => {
    const list = active.filter(match); const knownAmount = sumTryRemaining(list);
    return { id, label, count: list.length, knownAmount, unknownCount: list.filter((row) => remainingPayment(row) == null).length, foreignCurrencyCount: list.filter((row) => !isComparableCurrency(row.currency)).length, share: knownTotal ? knownAmount / knownTotal : 0, peakDate: dateTotal(list) };
  });
  const overdue = active.filter((row) => row.due_date < asOf);
  const ageDefs: Array<[PaymentAgeingBucket["id"], string, number, number]> = [["1-30", "1–30 gün", 1, 30], ["31-90", "31–90 gün", 31, 90], ["91+", "91+ gün", 91, Infinity]];
  const overdueKnown = sumTryRemaining(overdue);
  const ageing = ageDefs.map(([id, label, min, max]) => {
    const list = overdue.filter((row) => { const days = Math.floor((Date.parse(asOf) - Date.parse(row.due_date)) / 86400000); return days >= min && days <= max; });
    const knownAmount = sumTryRemaining(list);
    return { id, label, count: list.length, knownAmount, unknownCount: list.filter((row) => remainingPayment(row) == null).length, foreignCurrencyCount: list.filter((row) => !isComparableCurrency(row.currency)).length, oldestDueDate: list.map((row) => row.due_date).sort()[0] ?? null, share: overdueKnown ? knownAmount / overdueKnown : 0 };
  });
  const flexDefs: Array<[Flexibility, string]> = [["critical", "Kritik"], ["flexible", "Esnek"], ["optional", "İsteğe bağlı"], ["unclassified", "Sınıflandırılmadı"]];
  const flexibility = flexDefs.map(([id, label]) => { const list = active.filter((row) => flexibilityOf(row) === id); return { id, label, count: list.length, templateCount: new Set(list.map((row) => row.payment_id ?? row.id)).size, knownAmount: sumTryRemaining(list), unknownCount: list.filter((row) => remainingPayment(row) == null).length, foreignCurrencyCount: list.filter((row) => !isComparableCurrency(row.currency)).length }; });
  const watchList = active.map((row) => ({ ...row, remaining: remainingPayment(row), daysOverdue: Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(row.due_date)) / 86400000)), decisionFlexibility: flexibilityOf(row) }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || Number(b.decisionFlexibility === "critical") - Number(a.decisionFlexibility === "critical") || (b.remaining ?? -1) - (a.remaining ?? -1)).slice(0, 8);
  return { knownTotal, unknownCount: active.filter((row) => remainingPayment(row) == null).length, foreignCurrencyCount: active.filter((row) => !isComparableCurrency(row.currency)).length, recordCount: active.length, horizons, ageing, flexibility, watchList };
}

export function paymentPressureModel(rows: InstanceRow[], asOf: string, options: { criticalThreshold?: number } = {}): ChartModel {
  const statuses = ["overdue", "partial", "planned"] as const;
  const tones = { overdue: "negative", partial: "warning", planned: "info" } as const;
  const displayStatus = (row: InstanceRow) => pressureStatus(row, asOf);
  const remaining = remainingPayment;
  const rowsByDate = new Map<string, InstanceRow[]>();
  for (const row of rows) {
    if (displayStatus(row) == null) continue;
    const bucket = rowsByDate.get(row.due_date) ?? [];
    bucket.push(row);
    rowsByDate.set(row.due_date, bucket);
  }
  const dates = [...rowsByDate.keys()].sort();
  const dailyTotals = new Map(dates.map((date) => [date, sumTryRemaining(rowsByDate.get(date) ?? [])]));
  return {
    title: "Günlük ödeme baskısı", description: "Gecikmiş borçlar ve önümüzdeki dönemin kalan ödeme yükü.",
    asOf, timeDirection: "forward", preferredView: "stacked", summaryMode: "sum", minimumVisibleSeries: [...statuses], availableGranularities: ["day", "week", "month"], defaultGranularityByPeriod: { "3m": "day", "6m": "week", "12m": "month", "24m": "month", all: "month" }, criticalThreshold: options.criticalThreshold, sourceLabel: "Ödeme kalemleri", sourceHref: "/payments/items", unknownCount: rows.filter((r) => r.amount == null && displayStatus(r) != null).length,
    annotations: options.criticalThreshold == null ? [] : dates.filter((date) => (dailyTotals.get(date) ?? 0) >= options.criticalThreshold!).map((date) => ({ pointKey: date, label: "Kritik günlük eşik aşıldı", severity: "critical" as const, href: `/payments/calendar?date=${date}` })),
    series: statuses.map((status) => ({
      id: status, label: status === "overdue" ? "Gecikmiş" : status === "partial" ? "Kısmi" : "Planlı",
      tone: tones[status], format: "currency",
      points: dates.flatMap((date) => {
        const matching = (rowsByDate.get(date) ?? []).filter((row) => displayStatus(row) === status);
        if (matching.length === 0) return [];
        const known = matching.map(tryRemaining).filter((value): value is number => value != null);
        const value = known.length === 0 ? null : known.reduce((sum, amount) => sum + amount, 0);
        const meta: PaymentPressurePointMeta = {
          overdueCount: status === "overdue" ? matching.length : 0, partialCount: status === "partial" ? matching.length : 0, plannedCount: status === "planned" ? matching.length : 0,
          criticalCount: matching.filter((row) => flexibilityOf(row) === "critical").length, flexibleCount: matching.filter((row) => flexibilityOf(row) === "flexible").length,
          optionalCount: matching.filter((row) => flexibilityOf(row) === "optional").length, unclassifiedCount: matching.filter((row) => flexibilityOf(row) === "unclassified").length,
          unknownAmountCount: matching.filter((row) => remaining(row) == null).length, foreignCurrencyCount: matching.filter((row) => !isComparableCurrency(row.currency)).length,
        };
        return { ...point(date, date.slice(5), value, `/payments/calendar?date=${date}`), meta, remainingValue: value, statusReason: status === "overdue" ? "Vadesi geçti ve kalan borcu var" : status === "partial" ? "Kısmi ödeme sonrası kalan" : "Bugün veya ileri vadeli açık ödeme" };
      }),
    })),
  };
}

export function debtServiceModel(items: MaturityItem[], asOf: string): ChartModel {
  const months = [...new Set(items.map((item) => item.dueDate.slice(0, 7)))].sort();
  const kinds = ["check", "loan_installment"] as const;
  return {
    title: "Borç servisi", description: "Çek ve kredi taksitlerinin bugünden ileri aylık bilinen ödeme yükü.",
    asOf, timeDirection: "forward", preferredView: "stacked", summaryMode: "sum", minimumVisibleSeries: ["check", "loan_installment"], sourceLabel: "Çekler ve kredi taksitleri", sourceHref: "/finance/maturities", unknownCount: items.filter((item) => item.amount == null).length, annotations: [],
    series: kinds.map((kind) => ({ id: kind, label: kind === "check" ? "Çek" : "Kredi taksiti", tone: kind === "check" ? "warning" : "negative", format: "currency", points: months.map((month) => point(month, month, items.filter((item) => item.kind === kind && item.direction === "outflow" && item.dueDate.startsWith(month) && item.amount != null).reduce((sum, item) => sum + (item.amount ?? 0), 0), "/finance/maturities")) })),
  };
}

export function capacityModel(rows: Array<{ operation_type: string; utilization_rate: number | null; capacity_model_name: string }>, asOf: string): ChartModel {
  return { title: "Makine kapasite kullanımı", description: "Operasyon bazında talep / kullanılabilir dakika oranı.", asOf, timeDirection: "categorical", sourceLabel: "Makine dakika tahsisleri", sourceHref: "/production/capacity", unknownCount: rows.filter((r) => r.utilization_rate == null).length, annotations: rows.filter((r) => (r.utilization_rate ?? 0) > 1).map((r) => ({ pointKey: `${r.capacity_model_name}:${r.operation_type}`, label: "Kapasite aşıldı", severity: "critical" })), series: [{ id: "utilization", label: "Kullanım", tone: "info", format: "percent", points: rows.map((r) => point(`${r.capacity_model_name}:${r.operation_type}`, `${r.capacity_model_name} · ${r.operation_type}`, r.utilization_rate, "/production/capacity")) }] };
}

export function profitabilityModel(rows: Array<{ part_code: string | null; part_name: string; margin_rate: number | null }>, asOf: string): ChartModel {
  return { title: "Parça marj dağılımı", description: "En düşük marjlı parçalar; eksik oranlar çizilmez.", asOf, timeDirection: "categorical", sourceLabel: "Parça kârlılık çalışmaları", sourceHref: "/production/profitability", unknownCount: rows.filter((r) => r.margin_rate == null).length, annotations: [], series: [{ id: "margin", label: "Marj", tone: "scenario", format: "percent", points: rows.slice(0, 40).map((r, index) => point(`${r.part_code ?? index}`, r.part_code ?? r.part_name, r.margin_rate, "/production/profitability")) }] };
}

export function metricHistoryModel(rows: Array<{ snapshot_date: string; dimension_key: string; value_numeric: number | null; unknown_count: number }>, title: string, format: "currency" | "percent" | "count", asOf: string): ChartModel {
  const dimensions = [...new Set(rows.map((r) => r.dimension_key))];
  return { title, description: "İdempotent günlük metrik snapshot geçmişi.", asOf, sourceLabel: "Metrik snapshotları", sourceHref: "/system/audit", unknownCount: rows.reduce((sum, row) => sum + row.unknown_count, 0), annotations: [], series: dimensions.map((dimension, index) => ({ id: dimension, label: dimension, tone: index === 0 ? "info" : "neutral", format, points: rows.filter((r) => r.dimension_key === dimension).map((r) => point(r.snapshot_date, r.snapshot_date.slice(5), r.value_numeric)) })) };
}
