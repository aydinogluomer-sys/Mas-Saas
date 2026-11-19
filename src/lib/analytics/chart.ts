export type ChartValue = number | null;
export type ChartTone = "positive" | "negative" | "warning" | "info" | "neutral" | "scenario";
export type ChartFormat = "currency" | "percent" | "minutes" | "count" | "decimal";
export type ProjectionKind = "confirmed" | "projected";
export type ChartScaleMode = "window" | "global";

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
  projectionKind?: ProjectionKind;
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
  projectionKind?: ProjectionKind;
}

export interface ChartAnnotation {
  pointKey: string;
  label: string;
  severity: "critical" | "warning" | "info";
  href?: string;
}

export interface ChartOverdueSummary {
  total: number;
  count: number;
  href: string;
  pointKeys: string[];
}

export interface ChartModel {
  title: string;
  description: string;
  series: ChartSeries[];
  annotations?: ChartAnnotation[];
  unknownCount?: number;
  sourceLabel: string;
  sourceHref?: string;
  asOf: string;
  timeDirection?: "historical" | "forward" | "categorical" | "both";
  preferredView?: "combined" | "stacked" | "small-multiples" | "grouped";
  minimumVisibleSeries?: string[];
  availableGranularities?: ChartGranularity[];
  defaultGranularityByPeriod?: Partial<Record<AnalyticsPeriod, ChartGranularity>>;
  criticalThreshold?: number;
  /** Per-period readout under the chart: "sum" totals flow series over the selected window
   *  (payments, income/expense, debt service); "endpoint" shows the last value of a balance
   *  series (cash trend), where summing would be meaningless. */
  summaryMode?: "sum" | "endpoint";
  overdueSummary?: ChartOverdueSummary | null;
  currencyCode?: "TRY" | "USD" | "EUR" | "GBP" | "CONSOLIDATED";
}

export type AnalyticsPeriod = "3m" | "6m" | "12m" | "24m" | "all";

export interface FilterChartOptions {
  excludeOverdue?: boolean;
}

export interface ChartDomainOptions {
  scaleMode?: ChartScaleMode;
  globalModel?: ChartModel;
  headroomPct?: number;
  excludeOverdue?: boolean;
}

const PERIOD_LENGTH: Record<Exclude<AnalyticsPeriod, "all">, number> = {
  "3m": 3,
  "6m": 6,
  "12m": 12,
  "24m": 24,
};

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

/**
 * Extracts past-due obligations into a structured summary so `AnalyticsChart` can display
 * a dedicated "Vadesi Geçmiş Yük" callout pill/bar without freezing forward Y-axis scales.
 */
export function extractOverdueSummary(model: ChartModel): ChartOverdueSummary | null {
  if (model.overdueSummary !== undefined) return model.overdueSummary;
  if (model.timeDirection !== "forward") return null;

  const temporalKeyType = detectTemporalKeyType(model);
  const anchorKey = temporalKeyType === "month" ? model.asOf.slice(0, 7) : model.asOf;

  let total = 0;
  let count = 0;
  let firstHref: string | null = null;
  const keySet = new Set<string>();

  for (const series of model.series) {
    for (const point of series.points) {
      const pointKey = temporalKeyType === "month" ? point.key.slice(0, 7) : point.key;
      const isOverduePoint = series.id === "overdue" || pointKey < anchorKey;
      if (!isOverduePoint) continue;
      const val = point.value ?? 0;
      const metaCount = Number(point.meta?.overdueCount ?? 0);
      if (val <= 0 && metaCount <= 0) continue;
      if (val > 0) total += val;
      count += metaCount > 0 ? metaCount : val > 0 ? 1 : 0;
      keySet.add(point.key);
      if (!firstHref && point.href) firstHref = point.href;
    }
  }

  if (total <= 0 && count <= 0) return null;
  return {
    total,
    count,
    href: firstHref ?? "/payments/list?status=overdue",
    pointKeys: [...keySet].sort(),
  };
}

export function filterChartPeriod(
  model: ChartModel,
  period: AnalyticsPeriod,
  granularity: ChartGranularity = "day",
  options?: FilterChartOptions,
): ChartModel {
  const overdueSummary = extractOverdueSummary(model);
  if (period === "all") {
    return overdueSummary ? { ...model, overdueSummary } : model;
  }

  const take = PERIOD_LENGTH[period];
  const temporalKeyType = detectTemporalKeyType(model);

  if (model.timeDirection === "forward") {
    const from = model.asOf;
    const to = addMonthsToDay(from, take);
    const useMonthWindow = granularity === "month" || temporalKeyType === "month";
    const fromKey = useMonthWindow ? from.slice(0, 7) : from;
    const toKey = useMonthWindow ? to.slice(0, 7) : to;
    const excludeOverdue = options?.excludeOverdue === true;

    const filtered: ChartModel = {
      ...model,
      ...(overdueSummary ? { overdueSummary } : {}),
      series: model.series.map((series) => ({
        ...series,
        points: series.points.filter((point) => {
          const key = useMonthWindow ? point.key.slice(0, 7) : point.key;
          if (excludeOverdue) {
            if (series.id === "overdue" && key < fromKey) return false;
            return key >= fromKey && key < toKey;
          }
          return (
            (model.minimumVisibleSeries?.includes("overdue") && series.id === "overdue" && key < fromKey) ||
            (key >= fromKey && key < toKey)
          );
        }),
      })),
    };
    return filtered;
  }

  if (model.timeDirection === "categorical") return model;

  if (model.timeDirection === "both") {
    const backMonths = Math.max(1, Math.floor(take / 3));
    const forwardMonths = Math.max(1, take - backMonths);
    if (temporalKeyType === "month" || granularity === "month") {
      const anchorMonth = model.asOf.slice(0, 7);
      const fromMonth = addMonthsToMonth(anchorMonth, -backMonths);
      const toMonth = addMonthsToMonth(anchorMonth, forwardMonths);
      return {
        ...model,
        series: model.series.map((series) => ({
          ...series,
          points: series.points.filter((point) => {
            const k = point.key.slice(0, 7);
            return k >= fromMonth && k <= toMonth;
          }),
        })),
      };
    }
    const fromDay = addMonthsToDay(model.asOf, -backMonths);
    const toDay = addMonthsToDay(model.asOf, forwardMonths);
    return {
      ...model,
      series: model.series.map((series) => ({
        ...series,
        points: series.points.filter((point) => point.key >= fromDay && point.key <= toDay),
      })),
    };
  }

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

  return {
    ...model,
    series: model.series.map((series) => ({
      ...series,
      points: series.points.slice(-take),
    })),
  };
}

function weekStart(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/**
 * Aggregates daily chart series into weekly or monthly buckets for BOTH `forward` AND `historical`
 * time series. Uses period-end closing value when `summaryMode === "endpoint"`, and sums flow series
 * otherwise.
 */
export function aggregateChartGranularity(model: ChartModel, granularity: ChartGranularity): ChartModel {
  if (model.timeDirection === "categorical" || granularity === "day") return model;
  const temporalKeyType = detectTemporalKeyType(model);
  if (temporalKeyType === "month") return model;

  const isEndpoint = model.summaryMode === "endpoint";
  const isForward = model.timeDirection === "forward";

  return {
    ...model,
    series: model.series.map((series) => {
      const buckets = new Map<string, ChartPoint[]>();
      for (const point of series.points) {
        const key = granularity === "month" ? point.key.slice(0, 7) : weekStart(point.key);
        const list = buckets.get(key);
        if (list) list.push(point);
        else buckets.set(key, [point]);
      }

      return {
        ...series,
        points: [...buckets.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, points]) => {
            const knownPoints = points.filter((p): p is ChartPoint & { value: number } => p.value != null);
            const aggregatedValue =
              knownPoints.length === 0
                ? null
                : isEndpoint
                  ? knownPoints[knownPoints.length - 1].value
                  : knownPoints.reduce((sum, p) => sum + p.value, 0);

            const meta: Record<string, string | number | boolean | null> = {};
            for (const point of points) {
              for (const [name, value] of Object.entries(point.meta ?? {})) {
                if (typeof value === "number") {
                  meta[name] = isEndpoint ? value : Number(meta[name] ?? 0) + value;
                } else if (value != null) {
                  meta[name] = value;
                }
              }
            }

            const allProjected =
              points.length > 0 &&
              points.every((p) => (p.projectionKind ?? series.projectionKind) === "projected");
            const anyProjected = points.some((p) => (p.projectionKind ?? series.projectionKind) === "projected");
            if (anyProjected && !isEndpoint) {
              const projectedSum = knownPoints
                .filter((p) => (p.projectionKind ?? series.projectionKind) === "projected")
                .reduce((sum, p) => sum + p.value, 0);
              meta.projectedAmount = projectedSum;
            }

            const lastPoint = points[points.length - 1];
            const defaultHref = isForward
              ? granularity === "month"
                ? `/payments/calendar?month=${key}`
                : `/payments/calendar?from=${key}`
              : lastPoint?.href;

            const defaultStatusReason = isForward
              ? isEndpoint
                ? granularity === "month"
                  ? "Aylık dönem sonu bakiye"
                  : "Haftalık dönem sonu bakiye"
                : granularity === "month"
                  ? "Aylık kalan ödeme yükü"
                  : "Haftalık kalan ödeme yükü"
              : isEndpoint
                ? granularity === "month"
                  ? "Aylık kapanış bakiyesi"
                  : "Haftalık kapanış bakiyesi"
                : granularity === "month"
                  ? "Aylık toplam akış"
                  : "Haftalık toplam akış";

            return {
              key,
              label: granularity === "month" ? key : `${key} haftası`,
              value: aggregatedValue,
              href: defaultHref,
              remainingValue: aggregatedValue,
              statusReason: defaultStatusReason,
              projectionKind: allProjected ? "projected" : series.projectionKind,
              meta,
            };
          }),
      };
    }),
  };
}

function computeRawBounds(target: ChartModel, excludeOverdue: boolean): { min: number; max: number; hasValues: boolean } {
  const temporalKeyType = detectTemporalKeyType(target);
  const anchorKey = temporalKeyType === "month" ? target.asOf.slice(0, 7) : target.asOf;

  const filteredSeries =
    excludeOverdue && target.timeDirection === "forward"
      ? target.series.map((s) => ({
          ...s,
          points: s.points.filter((p) => {
            const pk = temporalKeyType === "month" ? p.key.slice(0, 7) : p.key;
            if (s.id === "overdue" && pk < anchorKey) return false;
            return pk >= anchorKey;
          }),
        }))
      : target.series;

  const values = filteredSeries
    .flatMap((series) => series.points.map((point) => point.value))
    .filter((value): value is number => value != null);

  if (!values.length) {
    return { min: 0, max: 1, hasValues: false };
  }

  const min = Math.min(0, ...values);
  const allKeys = [...new Set(filteredSeries.flatMap((series) => series.points.map((point) => point.key)))];
  const stackedMax =
    target.preferredView === "stacked"
      ? Math.max(
          0,
          ...allKeys.map((key) =>
            filteredSeries.reduce(
              (sum, series) => sum + Math.max(0, series.points.find((point) => point.key === key)?.value ?? 0),
              0,
            ),
          ),
        )
      : 0;
  const max = Math.max(0, stackedMax, ...values);
  return { min, max, hasValues: true };
}

/**
 * Computes Y-axis domain.
 * - 1-arg call (`chartDomain(model)`): exact `[min, max]` anchored at 0 (100% backwards-compatible).
 * - With `options`: supports `scaleMode: "window" | "global"`, overdue isolation, and 15% vertical headroom.
 */
export function chartDomain(model: ChartModel, options?: ChartDomainOptions): { min: number; max: number } {
  if (!options) {
    const raw = computeRawBounds(model, false);
    if (!raw.hasValues) return { min: 0, max: 1 };
    return raw.min === raw.max ? { min: raw.min - 1, max: raw.max + 1 } : { min: raw.min, max: raw.max };
  }

  const sourceModel = options.scaleMode === "global" && options.globalModel ? options.globalModel : model;
  const raw = computeRawBounds(sourceModel, Boolean(options.excludeOverdue));
  if (!raw.hasValues) return { min: 0, max: 1 };

  const headroom = options.headroomPct ?? 0.15;
  const maxWithHeadroom = raw.max > 0 ? raw.max * (1 + headroom) : 0;
  const minWithHeadroom = raw.min < 0 ? raw.min * (1 + headroom) : 0;

  if (minWithHeadroom === maxWithHeadroom) {
    return { min: 0, max: 1 };
  }
  return { min: minWithHeadroom, max: maxWithHeadroom };
}

export function formatChartValue(value: ChartValue, format: ChartFormat, currencyCode?: ChartModel["currencyCode"]): string {
  if (value == null) return "TUTAR EKSİK";
  if (format === "currency") {
    const suffix =
      currencyCode === "USD"
        ? " USD"
        : currencyCode === "EUR"
          ? " EUR"
          : currencyCode === "GBP"
            ? " GBP"
            : " TL";
    return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(value) + suffix;
  }
  if (format === "percent") return "%" + new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(value * 100);
  if (format === "minutes") return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(value) + " dk";
  return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: format === "count" ? 0 : 2 }).format(value);
}

export function chartSummary(model: ChartModel): string {
  const visible = model.series.flatMap((series) => series.points).filter((point) => point.value != null).length;
  return `${model.title}. ${model.series.length} seri, ${visible} bilinen değer, ${model.unknownCount ?? 0} bilinmeyen değer. Veri itibarıyla ${model.asOf}.`;
}

export function chartToCsv(model: ChartModel): string {
  const keys = [...new Set(model.series.flatMap((series) => series.points.map((point) => point.key)))];
  const labels = new Map(model.series.flatMap((series) => series.points.map((point) => [point.key, point.label] as const)));
  const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const rows = [["key", "label", ...model.series.map((series) => series.label)].map(escape).join(",")];
  for (const key of keys) {
    const values = model.series.map((series) => series.points.find((point) => point.key === key)?.value);
    rows.push(
      [key, labels.get(key) ?? key, ...values.map((value) => (value == null ? "" : String(value)))].map(escape).join(","),
    );
  }
  return rows.join("\n");
}
