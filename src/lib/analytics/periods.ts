// Faz 34 — rolling windows and period-over-period comparison.
//
// Pure: no database, no clock, no LLM. Every function takes the data and the reference date as
// arguments, because an analysis whose answer depends on when it happened to run cannot be
// checked against yesterday's screenshot.
//
// The rule that shapes every function here: A MISSING PERIOD IS NOT A ZERO PERIOD. If last year's
// March has no data, the YoY change is UNKNOWN, not −100%. Returning −100% would invent a
// collapse that never happened, and it is exactly the kind of number that ends up in a board pack.

export type RollingWindow = 7 | 30 | 90 | 365;
export const ROLLING_WINDOWS: readonly RollingWindow[] = [7, 30, 90, 365] as const;

export type PeriodComparison = "mom" | "qoq" | "yoy";

export interface DatedValue {
  /** ISO day (YYYY-MM-DD) or month (YYYY-MM). */
  key: string;
  value: number | null;
}

export interface RollingPoint {
  key: string;
  /** Rolling aggregate, or null when nothing known fell in the window. */
  value: number | null;
  /** How many observations carried a known value. */
  knownCount: number;
  /** How many fell in the window but had an unknown value. Disclosed, never treated as 0. */
  unknownCount: number;
  /**
   * True when the window extends before the start of the data.
   *
   * Surfaced rather than hidden: the first 29 points of a 30-day rolling sum are computed over
   * fewer than 30 days and are systematically lower. A chart that draws them identically to the
   * rest shows a "trend" that is an artefact of where the data begins.
   */
  partial: boolean;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;

/** Days between two ISO days. Positive when `to` is later. */
function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/**
 * Rolling aggregate over a trailing window of N days.
 *
 * `mode` is explicit because the honest aggregate differs by metric: a flow (sales, payments)
 * sums, a level (cash balance, open receivables) averages. Defaulting to one of them would be
 * silently wrong for the other half of the metrics in this system.
 */
export function rollingWindow(
  series: readonly DatedValue[],
  window: RollingWindow,
  mode: "sum" | "average" = "sum",
): RollingPoint[] {
  const points = series
    .filter((p) => DAY_KEY.test(p.key))
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key));
  if (points.length === 0) return [];

  const firstKey = points[0].key;
  return points.map((p) => {
    const windowStart = new Date(Date.parse(`${p.key}T00:00:00Z`) - (window - 1) * 86400000)
      .toISOString().slice(0, 10);
    const inWindow = points.filter((q) => q.key >= windowStart && q.key <= p.key);
    const known = inWindow.filter((q) => q.value != null).map((q) => q.value as number);
    const unknownCount = inWindow.length - known.length;
    const total = known.reduce((s, v) => s + v, 0);
    return {
      key: p.key,
      // No known observation means UNKNOWN, not 0 — a window with nothing in it has no answer.
      value: known.length === 0 ? null : mode === "sum" ? total : total / known.length,
      knownCount: known.length,
      unknownCount,
      partial: dayDiff(firstKey, p.key) < window - 1,
    };
  });
}

/** Shift a YYYY-MM key by N months. */
export function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const COMPARISON_OFFSET: Record<PeriodComparison, number> = { mom: -1, qoq: -3, yoy: -12 };
export const COMPARISON_LABEL: Record<PeriodComparison, string> = {
  mom: "Önceki aya göre", qoq: "Önceki çeyreğe göre", yoy: "Geçen yıla göre",
};

export interface PeriodChange {
  key: string;
  current: number | null;
  previous: number | null;
  /** Absolute difference, or null when either side is unknown. */
  delta: number | null;
  /**
   * Relative change as a ratio (0.15 = +15%).
   *
   * Null when either side is unknown OR when the previous value is zero: a change "from zero" has
   * no percentage. Reporting Infinity, or 100%, would both be inventions.
   */
  changeRatio: number | null;
  /** Why the comparison could not be made, when it could not. Shown instead of a fake number. */
  unmeasurableReason: "previous_missing" | "current_missing" | "previous_zero" | null;
}

/**
 * Compare each point with the same point one month / quarter / year earlier.
 *
 * Works on YYYY-MM keys. The previous period is looked up BY KEY rather than by counting back N
 * positions in the array — a series with a gap would otherwise compare March against December and
 * label it "previous month".
 */
export function periodOverPeriod(
  series: readonly DatedValue[],
  comparison: PeriodComparison,
): PeriodChange[] {
  const months = series.filter((p) => MONTH_KEY.test(p.key));
  const byKey = new Map(months.map((p) => [p.key, p.value] as const));
  const offset = COMPARISON_OFFSET[comparison];

  return months
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((p) => {
      const prevKey = shiftMonth(p.key, offset);
      const hasPrev = byKey.has(prevKey);
      const previous = hasPrev ? byKey.get(prevKey) ?? null : null;
      const current = p.value;

      let reason: PeriodChange["unmeasurableReason"] = null;
      if (current == null) reason = "current_missing";
      else if (!hasPrev || previous == null) reason = "previous_missing";
      else if (previous === 0) reason = "previous_zero";

      return {
        key: p.key,
        current,
        previous,
        delta: reason == null ? (current as number) - (previous as number) : null,
        changeRatio: reason == null
          ? ((current as number) - (previous as number)) / Math.abs(previous as number)
          : null,
        unmeasurableReason: reason,
      };
    });
}

/**
 * Compound growth rate between the first and last known points of a monthly series.
 *
 * Returns null unless BOTH ends are known and the first is strictly positive: a growth rate out
 * of zero or out of a negative base is not a growth rate, it is a division that happens to
 * produce a number.
 */
export function compoundGrowth(series: readonly DatedValue[]): {
  ratePerMonth: number | null; months: number; unmeasurableReason: string | null;
} {
  const known = series
    .filter((p) => MONTH_KEY.test(p.key) && p.value != null)
    .sort((a, b) => a.key.localeCompare(b.key));
  if (known.length < 2) {
    return { ratePerMonth: null, months: 0, unmeasurableReason: "iki bilinen nokta gerekli" };
  }
  const first = known[0], last = known[known.length - 1];
  const months = (Number(last.key.slice(0, 4)) - Number(first.key.slice(0, 4))) * 12
    + (Number(last.key.slice(5, 7)) - Number(first.key.slice(5, 7)));
  if (months <= 0) return { ratePerMonth: null, months: 0, unmeasurableReason: "dönem yok" };
  const a = first.value as number, b = last.value as number;
  if (a <= 0) {
    return { ratePerMonth: null, months, unmeasurableReason: "başlangıç değeri pozitif değil" };
  }
  if (b <= 0) {
    return { ratePerMonth: null, months, unmeasurableReason: "bitiş değeri pozitif değil" };
  }
  return { ratePerMonth: Math.pow(b / a, 1 / months) - 1, months, unmeasurableReason: null };
}
