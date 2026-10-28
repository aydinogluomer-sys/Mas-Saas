import type { ChartModel, PaymentPressurePointMeta } from "@/lib/analytics/chart";
import type { PaymentDashboardBucket } from "./queries";

const count = (rows: PaymentDashboardBucket[]) => rows.reduce((sum, row) => sum + row.count, 0);
const amount = (rows: PaymentDashboardBucket[]) => rows.reduce((sum, row) => sum + row.knownAmount, 0);

export function paymentDashboardChart(
  buckets: PaymentDashboardBucket[],
  asOf: string,
  criticalThreshold: number,
): ChartModel {
  const statuses = ["overdue", "partial", "planned"] as const;
  const byDate = new Map<string, PaymentDashboardBucket[]>();
  for (const bucket of buckets) {
    const rows = byDate.get(bucket.dueDate) ?? [];
    rows.push(bucket);
    byDate.set(bucket.dueDate, rows);
  }
  const dates = [...byDate.keys()].sort();
  return {
    title: "Günlük ödeme baskısı",
    description: "Gecikmiş borçlar ve önümüzdeki dönemin kalan ödeme yükü.",
    asOf,
    timeDirection: "forward",
    preferredView: "stacked",
    summaryMode: "sum",
    minimumVisibleSeries: [...statuses],
    availableGranularities: ["day", "week", "month"],
    defaultGranularityByPeriod: { "3m": "day", "6m": "week", "12m": "month", "24m": "month", all: "month" },
    criticalThreshold,
    sourceLabel: "Ödeme kalemleri",
    sourceHref: "/payments/items",
    unknownCount: buckets.reduce((sum, row) => sum + row.unknownCount, 0),
    annotations: dates
      .filter((date) => amount(byDate.get(date) ?? []) >= criticalThreshold)
      .map((date) => ({ pointKey: date, label: "Kritik günlük eşik aşıldı", severity: "critical" as const, href: `/payments/calendar?date=${date}` })),
    series: statuses.map((status) => ({
      id: status,
      label: status === "overdue" ? "Gecikmiş" : status === "partial" ? "Kısmi" : "Planlı",
      tone: status === "overdue" ? "negative" as const : status === "partial" ? "warning" as const : "info" as const,
      format: "currency" as const,
      points: dates.flatMap((date) => {
        const rows = (byDate.get(date) ?? []).filter((row) => row.status === status);
        if (!rows.length) return [];
        const knownCount = rows.reduce((sum, row) => sum + row.count - row.unknownCount, 0);
        const value = knownCount ? amount(rows) : null;
        const meta: PaymentPressurePointMeta = {
          overdueCount: status === "overdue" ? count(rows) : 0,
          partialCount: status === "partial" ? count(rows) : 0,
          plannedCount: status === "planned" ? count(rows) : 0,
          criticalCount: rows.reduce((sum, row) => sum + row.criticalCount, 0),
          flexibleCount: rows.reduce((sum, row) => sum + row.flexibleCount, 0),
          optionalCount: rows.reduce((sum, row) => sum + row.optionalCount, 0),
          unclassifiedCount: rows.reduce((sum, row) => sum + row.unclassifiedCount, 0),
          unknownAmountCount: rows.reduce((sum, row) => sum + row.unknownCount, 0),
          foreignCurrencyCount: rows.reduce((sum, row) => sum + row.foreignCurrencyCount, 0),
        };
        return [{
          key: date,
          label: date.slice(5),
          value,
          href: `/payments/calendar?date=${date}`,
          meta,
          remainingValue: value,
          statusReason: status === "overdue" ? "Vadesi geçti ve kalan borcu var" : status === "partial" ? "Kısmi ödeme sonrası kalan" : "Bugün veya ileri vadeli açık ödeme",
        }];
      }),
    })),
  };
}
