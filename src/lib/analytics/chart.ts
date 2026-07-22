export type ChartValue = number | null;
export type ChartTone = "positive" | "negative" | "warning" | "info" | "neutral" | "scenario";
export type ChartFormat = "currency" | "percent" | "minutes" | "count" | "decimal";

export interface ChartPoint {
  key: string;
  label: string;
  value: ChartValue;
  href?: string;
  confidence?: "high" | "medium" | "low" | "unknown";
  freshness?: string | null;
  meta?: Record<string, string | number | boolean | null>;
  remainingValue?: number | null;
  statusReason?: string;
}

export type ChartGranularity = "day" | "week" | "month";

export interface PaymentPressurePointMeta {
  [key: string]: number;
  overdueCount: number;
  partialCount: number;
  plannedCount: number;
  criticalCount: number;
  flexibleCount: number;
  optionalCount: number;
  unclassifiedCount: number;
  unknownAmountCount: number;
  foreignCurrencyCount: number;
}

export interface ChartSeries {
  id: string;
  label: string;
  tone: ChartTone;
  points: ChartPoint[];
  format: ChartFormat;
  dashed?: boolean;
}

export interface ChartAnnotation {
  pointKey: string;
  label: string;
  severity: "critical" | "warning" | "info";
  href?: string;
}

export interface ChartModel {
  title: string;
  description: string;
  series: ChartSeries[];
  annotations: ChartAnnotation[];
  unknownCount: number;
  sourceLabel: string;
  sourceHref?: string;
  asOf: string;
  timeDirection?: "historical" | "forward" | "categorical";
  preferredView?: "combined" | "stacked" | "small-multiples";
  minimumVisibleSeries?: string[];
  availableGranularities?: ChartGranularity[];
  defaultGranularityByPeriod?: Partial<Record<AnalyticsPeriod, ChartGranularity>>;
  criticalThreshold?: number;
  /** Per-period readout under the chart: "sum" totals flow series over the selected window
   *  (payments, income/expense, debt service); "endpoint" shows the last value of a balance
   *  series (cash trend), where summing would be meaningless. */
  summaryMode?: "sum" | "endpoint";
}

export type AnalyticsPeriod = "3m" | "6m" | "12m" | "24m" | "all";

const PERIOD_LENGTH: Record<Exclude<AnalyticsPeriod, "all">, number> = { "3m": 3, "6m": 6, "12m": 12, "24m": 24 };

const MONTH_KEY = /^\d{4}-\d{2}$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function addMonthsToDay(isoDay: string, delta: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, d.getUTCDate())).toISOString().slice(0, 10);
}

function addMonthsToMonth(isoMonth: string, delta: number): string {
  const [year, month] = isoMonth.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function detectTemporalKeyType(model: ChartModel): "month" | "day" | null {
  const keys = model.series.flatMap((series) => series.points.map((point) => point.key));
  if (!keys.length) return null;
  if (keys.every((key) => MONTH_KEY.test(key))) return "month";
  if (keys.every((key) => DAY_KEY.test(key))) return "day";
  return null;
}

export function filterChartPeriod(model: ChartModel, period: AnalyticsPeriod, granularity: ChartGranularity = "day"): ChartModel {
  if (period === "all") return model;
  const take = PERIOD_LENGTH[period];
  const temporalKeyType = detectTemporalKeyType(model);
  if (model.timeDirection === "forward") {
    const from = model.asOf;
    const to = addMonthsToDay(from, take);
    const useMonthWindow = granularity === "month" || temporalKeyType === "month";
    const fromKey = useMonthWindow ? from.slice(0, 7) : from;
    const toKey = useMonthWindow ? to.slice(0, 7) : to;
    return { ...model, series: model.series.map((series) => ({ ...series, points: series.points.filter((point) => {
      const key = useMonthWindow ? point.key.slice(0, 7) : point.key;
      return (model.minimumVisibleSeries?.includes("overdue") && series.id === "overdue" && key < fromKey)
        || (key >= fromKey && key < toKey);
    }) })) };
  }
  if (model.timeDirection === "categorical") return model;
  if (temporalKeyType === "month") {
    const toMonth = model.asOf.slice(0, 7);
    const fromMonth = addMonthsToMonth(toMonth, -(take - 1));
    return {
      ...model,
      series: model.series.map((series) => ({
        ...series,
        points: series.points.filter((point) => point.key >= fromMonth && point.key <= toMonth),
      })),
    };
  }
  if (temporalKeyType === "day") {
    const fromDay = addMonthsToDay(model.asOf, -take);
    return {
      ...model,
      series: model.series.map((series) => ({
        ...series,
        points: series.points.filter((point) => point.key >= fromDay && point.key <= model.asOf),
      })),
    };
  }
  return { ...model, series: model.series.map((series) => ({ ...series, points: series.points.slice(-take) })) };
}

function weekStart(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function aggregateChartGranularity(model: ChartModel, granularity: ChartGranularity): ChartModel {
  if (model.timeDirection !== "forward" || granularity === "day") return model;
  return { ...model, series: model.series.map((series) => {
    const buckets = new Map<string, ChartPoint[]>();
    for (const point of series.points) {
      const key = granularity === "month" ? point.key.slice(0, 7) : weekStart(point.key);
      buckets.set(key, [...(buckets.get(key) ?? []), point]);
    }
    return { ...series, points: [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, points]) => {
      const known = points.map((point) => point.value).filter((value): value is number => value != null);
      const meta: Record<string, string | number | boolean | null> = {};
      for (const point of points) for (const [name, value] of Object.entries(point.meta ?? {})) {
        if (typeof value === "number") meta[name] = Number(meta[name] ?? 0) + value;
      }
      return {
        key,
        label: granularity === "month" ? key : `${key} haftası`,
        value: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
        href: granularity === "month" ? `/payments/calendar?month=${key}` : `/payments/calendar?from=${key}`,
        remainingValue: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
        statusReason: granularity === "month" ? "Aylık kalan ödeme yükü" : "Haftalık kalan ödeme yükü",
        meta,
      };
    }) };
  }) };
}

export function chartDomain(model: ChartModel): { min: number; max: number } {
  const values = model.series.flatMap((series) => series.points.map((point) => point.value)).filter((value): value is number => value != null);
  if (!values.length) return { min: 0, max: 1 };
  const min = Math.min(0, ...values);
  const stackedMax = model.preferredView === "stacked" ? Math.max(0, ...[...new Set(model.series.flatMap((series) => series.points.map((point) => point.key)))].map((key) => model.series.reduce((sum, series) => sum + Math.max(0, series.points.find((point) => point.key === key)?.value ?? 0), 0))) : 0;
  const max = Math.max(0, stackedMax, ...values);
  return min === max ? { min: min - 1, max: max + 1 } : { min, max };
}

export function formatChartValue(value: ChartValue, format: ChartFormat): string {
  if (value == null) return "TUTAR EKSİK";
  if (format === "currency") return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(value) + " TL";
  if (format === "percent") return "%" + new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(value * 100);
  if (format === "minutes") return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(value) + " dk";
  return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: format === "count" ? 0 : 2 }).format(value);
}

export function chartSummary(model: ChartModel): string {
  const visible = model.series.flatMap((series) => series.points).filter((point) => point.value != null).length;
  return `${model.title}. ${model.series.length} seri, ${visible} bilinen değer, ${model.unknownCount} bilinmeyen değer. Veri itibarıyla ${model.asOf}.`;
}

export function chartToCsv(model: ChartModel): string {
  const keys = [...new Set(model.series.flatMap((series) => series.points.map((point) => point.key)))];
  const labels = new Map(model.series.flatMap((series) => series.points.map((point) => [point.key, point.label] as const)));
  const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const rows = [["key", "label", ...model.series.map((series) => series.label)].map(escape).join(",")];
  for (const key of keys) {
    const values = model.series.map((series) => series.points.find((point) => point.key === key)?.value);
    rows.push([key, labels.get(key) ?? key, ...values.map((value) => value == null ? "" : String(value))].map(escape).join(","));
  }
  return rows.join("\n");
}
