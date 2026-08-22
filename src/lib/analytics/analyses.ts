// Faz 34 — the seven named analyses. Pure TypeScript, no database, no LLM, no Python.
//
// ═══ NO PYTHON, AND NO STATISTICS LIBRARY EITHER ═══
//
// Resolved decision #2 in implementation.md forbids Python. Nothing here needs it: the whole set
// is sums, sorts, ratios and cumulative totals. Reaching for a statistics package would add a
// dependency whose numeric behaviour nobody in this project could explain to an auditor, in
// exchange for arithmetic that fits on one screen.
//
// ═══ NO MONTE CARLO — see docs/status-notes.md for the full argument ═══
//
// Short version, because it belongs next to the code it explains: Monte Carlo needs input
// DISTRIBUTIONS, and this system stores none. Every input is a point value with provenance —
// `external_assumptions.value_numeric` is a single reviewed number with a source and a date, not
// a mean with a variance. Simulating would mean inventing the distributions, and a P95 that is
// downstream of a σ somebody made up is a confident-looking number with nothing behind it.

import { METRICS, type MetricFormat } from "./registry";

/* ── shared shapes ──────────────────────────────────────────────────────────────────────── */

export interface Contribution {
  key: string;
  label: string;
  value: number;
  /** Share of the (absolute) total, 0..1. */
  share: number;
}

export interface AnalysisResult<T> {
  analysisId: string;
  rows: T[];
  /** Observations that could not be used because their value was unknown. Never counted as 0. */
  unknownCount: number;
  /** Present when the analysis could not be performed at all. */
  unmeasurableReason: string | null;
}

const ok = <T>(analysisId: string, rows: T[], unknownCount = 0): AnalysisResult<T> =>
  ({ analysisId, rows, unknownCount, unmeasurableReason: null });
const unmeasurable = <T>(analysisId: string, reason: string, unknownCount = 0): AnalysisResult<T> =>
  ({ analysisId, rows: [], unknownCount, unmeasurableReason: reason });

/* ── 1. variance decomposition ──────────────────────────────────────────────────────────── */

export interface VarianceInput {
  key: string;
  label: string;
  budget: number | null;
  actual: number | null;
}

export interface VarianceRow extends Contribution {
  budget: number;
  actual: number;
  /** Overspend is positive. Named, so the sign is never guessed at the call site. */
  direction: "over_budget" | "under_budget" | "on_budget";
}

/**
 * Split a total budget variance into the lines that caused it, largest first.
 *
 * A line with an unknown budget or actual is EXCLUDED and counted, not treated as zero: a missing
 * actual would otherwise read as "spent nothing", which is the most flattering possible reading of
 * missing data.
 */
export function varianceDecomposition(input: readonly VarianceInput[]): AnalysisResult<VarianceRow> {
  const usable = input.filter((r) => r.budget != null && r.actual != null);
  const unknownCount = input.length - usable.length;
  if (usable.length === 0) {
    return unmeasurable("variance_decomposition", "Bütçe/gerçekleşen çifti olan satır yok", unknownCount);
  }
  const rows = usable.map((r) => {
    const budget = r.budget as number, actual = r.actual as number;
    const value = actual - budget;
    return {
      key: r.key, label: r.label, value, budget, actual, share: 0,
      direction: value > 0 ? "over_budget" as const
        : value < 0 ? "under_budget" as const : "on_budget" as const,
    };
  });
  const magnitude = rows.reduce((s, r) => s + Math.abs(r.value), 0);
  for (const r of rows) r.share = magnitude === 0 ? 0 : Math.abs(r.value) / magnitude;
  // Total order: magnitude desc, then key — so equal magnitudes never depend on input order.
  rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.key.localeCompare(b.key));
  return ok("variance_decomposition", rows, unknownCount);
}

/* ── 2. Pareto / concentration ──────────────────────────────────────────────────────────── */

export interface ParetoRow extends Contribution {
  cumulativeShare: number;
  /** True while this row is inside the smallest group making up `threshold` of the total. */
  inVitalFew: boolean;
}

export interface ParetoSummary {
  /** How many entries make up `threshold` of the total. The headline concentration number. */
  vitalFewCount: number;
  totalCount: number;
  threshold: number;
  total: number;
}

/**
 * Classic Pareto: sort descending, accumulate, mark the smallest set reaching the threshold.
 *
 * Negative values are rejected rather than silently absorbed. A "share of the total" is not
 * meaningful when entries can offset each other — with a −100 and a +100 the total is zero and
 * every share is infinite. Callers pass exposures, which are non-negative by construction.
 */
export function paretoConcentration(
  input: readonly { key: string; label: string; value: number | null }[],
  threshold = 0.8,
): AnalysisResult<ParetoRow> & { summary: ParetoSummary | null } {
  const usable = input.filter((r) => r.value != null) as { key: string; label: string; value: number }[];
  const unknownCount = input.length - usable.length;
  if (usable.some((r) => r.value < 0)) {
    return {
      ...unmeasurable<ParetoRow>("pareto_concentration",
        "Negatif değer var — pay hesabı anlamsız olurdu", unknownCount),
      summary: null,
    };
  }
  const total = usable.reduce((s, r) => s + r.value, 0);
  if (usable.length === 0 || total <= 0) {
    return {
      ...unmeasurable<ParetoRow>("pareto_concentration", "Toplam sıfır veya veri yok", unknownCount),
      summary: null,
    };
  }
  const sorted = usable.slice().sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  let cumulative = 0;
  let vitalFewCount = 0;
  let reached = false;
  const rows: ParetoRow[] = sorted.map((r) => {
    cumulative += r.value;
    const cumulativeShare = cumulative / total;
    const inVitalFew = !reached;
    if (!reached) {
      vitalFewCount += 1;
      if (cumulativeShare >= threshold) reached = true;
    }
    return { key: r.key, label: r.label, value: r.value, share: r.value / total, cumulativeShare, inVitalFew };
  });
  return {
    ...ok("pareto_concentration", rows, unknownCount),
    summary: { vitalFewCount, totalCount: sorted.length, threshold, total },
  };
}

/* ── 3. working capital decomposition ───────────────────────────────────────────────────── */

export interface WorkingCapitalComponent {
  key: string;
  label: string;
  /** Days. Null means UNMEASURABLE, and the reason says why. */
  days: number | null;
  /** How this component moves the cycle: +1 lengthens it, −1 shortens it. */
  sign: 1 | -1;
  unmeasurableReason: string | null;
}

/**
 * Break the cash cycle into DSO, DIO and DPO.
 *
 * DIO is ALWAYS unmeasurable here and says so, rather than being omitted. Leaving it out would
 * let a reader believe DSO − DPO is the whole cash conversion cycle; it is not, and the registry
 * carries dio_days precisely so the gap is visible instead of forgotten.
 */
export function workingCapitalDecomposition(input: {
  dsoDays: number | null; dpoDays: number | null;
}): AnalysisResult<WorkingCapitalComponent> & { cycleDays: number | null; complete: boolean } {
  const components: WorkingCapitalComponent[] = [
    {
      key: "dso_days", label: METRICS.dso_days.label, days: input.dsoDays, sign: 1,
      unmeasurableReason: input.dsoDays == null ? "Satış yok — günlük ortalama hesaplanamıyor" : null,
    },
    {
      key: "dio_days", label: METRICS.dio_days.label, days: null, sign: 1,
      unmeasurableReason: "Envanter verisi yok — bu sistemde hiç ölçülemez",
    },
    {
      key: "dpo_days", label: METRICS.dpo_days.label, days: input.dpoDays, sign: -1,
      unmeasurableReason: input.dpoDays == null ? "Alış yok — günlük ortalama hesaplanamıyor" : null,
    },
  ];
  const cycleDays = input.dsoDays == null || input.dpoDays == null
    ? null
    : Math.round((input.dsoDays - input.dpoDays) * 10) / 10;
  return {
    ...ok("working_capital_decomposition", components,
      components.filter((c) => c.days == null).length),
    cycleDays,
    // Never true in this system, and that is the point of reporting it.
    complete: false,
  };
}

/* ── 4. cash bridge ─────────────────────────────────────────────────────────────────────── */

export interface BridgeStep {
  key: string;
  label: string;
  /** Signed contribution. */
  value: number;
  kind: "start" | "increase" | "decrease" | "end";
  /** Running total after this step — what a waterfall chart draws. */
  runningTotal: number;
}

/**
 * Build a start → movements → end bridge.
 *
 * The end value is COMPUTED from the start plus the movements rather than taken as given, and the
 * caller gets `reconciles` telling it whether that matches the reported end. Silently drawing a
 * bridge that does not add up is how a chart ends up disagreeing with the ledger beneath it.
 */
export function cashBridge(input: {
  startLabel: string; startValue: number;
  endLabel: string; reportedEndValue: number | null;
  movements: readonly { key: string; label: string; value: number | null }[];
}): AnalysisResult<BridgeStep> & { computedEnd: number; reconciles: boolean | null; difference: number | null } {
  const usable = input.movements.filter((m) => m.value != null) as { key: string; label: string; value: number }[];
  const unknownCount = input.movements.length - usable.length;

  let running = input.startValue;
  const steps: BridgeStep[] = [
    { key: "__start", label: input.startLabel, value: input.startValue, kind: "start", runningTotal: running },
  ];
  for (const m of usable) {
    running += m.value;
    steps.push({
      key: m.key, label: m.label, value: m.value,
      kind: m.value >= 0 ? "increase" : "decrease",
      runningTotal: running,
    });
  }
  const computedEnd = running;
  steps.push({ key: "__end", label: input.endLabel, value: computedEnd, kind: "end", runningTotal: computedEnd });

  // Rounded to the kuruş before comparing: a float tail is not a reconciliation failure.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const reconciles = input.reportedEndValue == null
    ? null
    : round2(input.reportedEndValue) === round2(computedEnd);
  const difference = input.reportedEndValue == null
    ? null
    : round2(input.reportedEndValue - computedEnd);

  return { ...ok("cash_bridge", steps, unknownCount), computedEnd, reconciles, difference };
}

/* ── 5. ageing distribution ─────────────────────────────────────────────────────────────── */

export const AGEING_BUCKETS = [
  { key: "current", label: "Vadesi gelmemiş", minDays: Number.NEGATIVE_INFINITY, maxDays: 0 },
  { key: "d1_30", label: "1-30 gün", minDays: 1, maxDays: 30 },
  { key: "d31_60", label: "31-60 gün", minDays: 31, maxDays: 60 },
  { key: "d61_90", label: "61-90 gün", minDays: 61, maxDays: 90 },
  { key: "d90_plus", label: "90+ gün", minDays: 91, maxDays: Number.POSITIVE_INFINITY },
] as const;

export interface AgeingRow {
  bucketKey: string;
  bucketLabel: string;
  amount: number;
  count: number;
  share: number;
}

/**
 * Bucket open items by how overdue they are.
 *
 * An item with no due date is NOT placed in "current" — it is excluded and counted as unknown.
 * Guessing that a missing due date means "not yet due" is the optimistic assumption, and this
 * system's rule is that missing data is disclosed, not assumed.
 */
export function ageingDistribution(
  items: readonly { dueDate: string | null; amount: number | null }[],
  asOfISO: string,
): AnalysisResult<AgeingRow> {
  const usable = items.filter((i) => i.dueDate != null && i.amount != null);
  const unknownCount = items.length - usable.length;
  if (usable.length === 0) {
    return unmeasurable("ageing_distribution", "Vadesi ve tutarı bilinen açık kalem yok", unknownCount);
  }
  const asOf = Date.parse(`${asOfISO}T00:00:00Z`);
  const totals = new Map<string, { amount: number; count: number }>();
  for (const b of AGEING_BUCKETS) totals.set(b.key, { amount: 0, count: 0 });

  for (const item of usable) {
    const overdueDays = Math.round((asOf - Date.parse(`${item.dueDate as string}T00:00:00Z`)) / 86400000);
    const bucket = AGEING_BUCKETS.find((b) => overdueDays >= b.minDays && overdueDays <= b.maxDays)
      ?? AGEING_BUCKETS[AGEING_BUCKETS.length - 1];
    const acc = totals.get(bucket.key) as { amount: number; count: number };
    acc.amount += item.amount as number;
    acc.count += 1;
  }
  const grand = [...totals.values()].reduce((s, t) => s + t.amount, 0);
  const rows: AgeingRow[] = AGEING_BUCKETS.map((b) => {
    const t = totals.get(b.key) as { amount: number; count: number };
    return {
      bucketKey: b.key, bucketLabel: b.label, amount: t.amount, count: t.count,
      share: grand === 0 ? 0 : t.amount / grand,
    };
  });
  return ok("ageing_distribution", rows, unknownCount);
}

/* ── 6 & 7 live in periods.ts (periodOverPeriod, rollingWindow) ─────────────────────────── */

/** Format helper shared by the UI and the exporters, so one number never renders two ways. */
export function formatMetric(value: number | null, format: MetricFormat): string {
  if (value == null) return "—";
  switch (format) {
    case "currency":
      return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(value) + " TL";
    case "percent":
      return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(value * 100) + "%";
    case "days":
      return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(value) + " gün";
    case "ratio":
      return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(value);
    case "count":
    default:
      return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(value);
  }
}
