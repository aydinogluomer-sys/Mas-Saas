// Faz 28 — budget and rolling-forecast rules. Pure, deterministic, decimal.
//
// ═══ THIS MODULE MUST NEVER IMPORT @/lib/ai, AND phase28:verify ENFORCES IT ═══
//
// The plan calls this "reinforcement, not new work": forecast mathematics stays in TypeScript and
// SQL, and the LLM stays entirely outside the forecast chain. src/lib/ai/engine.ts already has the
// right boundary — it computes a deterministic answer first and only lets a model phrase
// commentary on top — and this phase must not erode it.
//
// So the arrangement is one-directional by construction: budget/forecast modules know nothing
// about the AI layer, and the AI layer may read their OUTPUT like any other fact. A variance
// number that had passed through a language model would be unreproducible, and the entire point
// of a variance report is that two people computing it get the same figure.

import { decimal, moneyOrNull, ratioOrNull, type NumericInput } from "@/lib/money";
import { partitionByCurrency } from "@/lib/currency-policy";

/* ── version lifecycle, mirroring migrations 0068/0069 ────────────────────────────────── */

export const VERSION_STATUSES = ["draft", "approved", "superseded"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/**
 * The three permitted moves. Identical for budget_lines and forecast_lines because they carry the
 * same lifecycle for the same reason.
 *
 * `approved -> draft` is absent deliberately: reopening an approved line would silently rewrite a
 * figure someone signed off, and every variance report built on it would change underneath its
 * readers with no record. A revision is a NEW line that supersedes the old one.
 */
export const VERSION_TRANSITIONS: ReadonlyArray<readonly [VersionStatus, VersionStatus]> = [
  ["draft", "approved"],
  ["draft", "superseded"],
  ["approved", "superseded"],
] as const;

export function canTransition(from: VersionStatus, to: VersionStatus): boolean {
  if (from === to) return true;
  return VERSION_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/* ── source classification ────────────────────────────────────────────────────────────── */

export const SOURCE_KINDS = [
  "contracted", "scheduled", "historical", "manual", "estimated",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Default confidence per source kind — a fixed table, not a learned weight.
 *
 * These are starting values a person can override per line; the column stores whatever was
 * actually used. They are ordered by how much the NUMBER'S ORIGIN can be relied on, which is a
 * statement about provenance rather than about optimism.
 */
export const SOURCE_CONFIDENCE: Record<SourceKind, number> = {
  contracted: 0.95,
  scheduled: 0.85,
  historical: 0.7,
  manual: 0.6,
  estimated: 0.5,
};

export const SOURCE_LABEL: Record<SourceKind, string> = {
  contracted: "sözleşmeli",
  scheduled: "planlı",
  historical: "geçmişe dayalı",
  manual: "elle girilen",
  estimated: "tahmini",
};

/* ── variance ─────────────────────────────────────────────────────────────────────────── */

export type VarianceVerdict =
  | "not_measured" | "over_budget" | "within_budget" | "under_target" | "on_or_above_target";

export interface Variance {
  budgetAmount: number;
  actualAmount: number | null;
  /** actual − budget. NULL when nothing has been measured. */
  varianceAmount: number | null;
  varianceRatio: number | null;
  verdict: VarianceVerdict;
}

/**
 * Budget versus actual for one line.
 *
 * DIRECTION MATTERS, and getting it wrong is the easy mistake: overspending an expense budget and
 * overshooting an income budget are opposite outcomes. A single unsigned "variance" would colour
 * a good month red. The verdict is therefore computed from the direction, not from the sign alone.
 *
 * An unmeasured period yields NULL and the verdict `not_measured` — never 0. Zero would assert
 * "nothing was spent", which is a claim; a missing actual means nobody has recorded one yet.
 * `phase28:verify` proves the SQL view and this function agree on identical inputs.
 */
export function variance(
  direction: "income" | "expense",
  budgetAmount: NumericInput,
  actualAmount: NumericInput,
): Variance {
  const budget = moneyOrNull(budgetAmount) ?? 0;
  const actual = moneyOrNull(actualAmount);

  if (actual === null) {
    return {
      budgetAmount: budget, actualAmount: null,
      varianceAmount: null, varianceRatio: null, verdict: "not_measured",
    };
  }

  const varianceAmount = Number(decimal(actual).minus(decimal(budget)).toFixed(2));
  const varianceRatio = budget === 0 ? null : ratioOrNull(varianceAmount, budget);

  const verdict: VarianceVerdict =
    direction === "expense"
      ? (actual > budget ? "over_budget" : "within_budget")
      : (actual < budget ? "under_target" : "on_or_above_target");

  return { budgetAmount: budget, actualAmount: actual, varianceAmount, varianceRatio, verdict };
}

export const VERDICT_LABEL: Record<VarianceVerdict, string> = {
  not_measured: "ölçülmedi",
  over_budget: "bütçe aşımı",
  within_budget: "bütçe içinde",
  under_target: "hedefin altında",
  on_or_above_target: "hedefte veya üzerinde",
};

/* ── the 13-week horizon ──────────────────────────────────────────────────────────────── */

export const FORECAST_WEEKS = 13;

export interface WeekBucket {
  weekNo: number;
  weekStart: string;
  weekEnd: string;
}

/**
 * The 13 week buckets from an anchor date.
 *
 * Generated rather than derived from whatever rows exist, so the horizon is always exactly 13
 * buckets. A week with no forecast line must appear as an empty week — a missing week silently
 * dropping out of a cash forecast is how a gap becomes invisible.
 *
 * Ranges are INCLUSIVE on both ends (week 1 is anchor..anchor+6) and contiguous, so no day
 * belongs to two weeks or to none.
 */
export function weekBuckets(anchorISO: string, weeks = FORECAST_WEEKS): WeekBucket[] {
  return Array.from({ length: weeks }, (_, i) => ({
    weekNo: i + 1,
    weekStart: addDays(anchorISO, i * 7),
    weekEnd: addDays(anchorISO, i * 7 + 6),
  }));
}

export function addDays(fromISO: string, days: number): string {
  const d = new Date(`${fromISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── accuracy ─────────────────────────────────────────────────────────────────────────── */

export interface AccuracyInput {
  forecast: NumericInput;
  actual: NumericInput;
  /** PHASE 2.2 (#64): alan varsa ve TRY değilse satır skorlanmaz, `foreignCount`ta sayılır. */
  currency?: string | null;
}

export interface Accuracy {
  measuredCount: number;
  /** Signed: positive means actuals came in above forecast. */
  biasTotal: number;
  absoluteErrorTotal: number;
  /** Mean absolute percentage error over non-zero forecasts; null when none qualify. */
  mape: number | null;
  zeroForecastLines: number;
  /** TRY-dışı satır — doğruluk hesabına girmedi. */
  foreignCount: number;
}

/**
 * Forecast accuracy over measured lines only.
 *
 * TWO EXCLUSIONS, both of which would otherwise flatter the number:
 *   - a line with no actual is SKIPPED, not scored as perfect. Counting it would make a forecast
 *     look more accurate the less of it had been checked, which is exactly backwards.
 *   - a zero-forecast line is excluded from MAPE, because dividing by zero is undefined and
 *     treating it as 100% error would let one such line dominate the KPI. The count is reported
 *     separately so the exclusion is visible rather than silent.
 */
export function accuracy(rows: AccuracyInput[]): Accuracy {
  let bias = decimal(0);
  let absErr = decimal(0);
  let pctSum = decimal(0);
  let measured = 0;
  let pctCount = 0;
  let zeroForecast = 0;
  // PHASE 2.2 (#64): para birimi taşıyan satırlarda yalnız TRY skorlanır; TRY-dışı satır
  // doğruluk hesabına girmez (kur yok) ve `foreignCount` ile raporlanır.
  const { comparable, foreignCount } = partitionByCurrency(rows);

  for (const r of comparable) {
    const f = moneyOrNull(r.forecast);
    const a = moneyOrNull(r.actual);
    if (f === null || a === null) continue; // unmeasured — skipped, not scored
    measured += 1;
    const diff = decimal(a).minus(decimal(f));
    bias = bias.plus(diff);
    absErr = absErr.plus(diff.abs());
    if (f === 0) {
      zeroForecast += 1;
      continue;
    }
    pctSum = pctSum.plus(diff.abs().div(decimal(Math.abs(f))));
    pctCount += 1;
  }

  return {
    measuredCount: measured,
    foreignCount,
    biasTotal: Number(bias.toFixed(2)),
    absoluteErrorTotal: Number(absErr.toFixed(2)),
    mape: pctCount === 0 ? null : Number(pctSum.div(decimal(pctCount)).toFixed(4)),
    zeroForecastLines: zeroForecast,
  };
}

/**
 * Confidence-weighted net flow for a week.
 *
 * An unscored line contributes its FACE VALUE (weight 1) rather than vanishing. Dropping it would
 * understate the week, and a cash forecast that quietly omits money is worse than one that
 * includes it at full weight and says the confidence is unknown.
 */
export function weightedNet(
  lines: Array<{ amount: NumericInput; direction: "inflow" | "outflow"; confidence?: number | null; currency?: string | null }>,
): number {
  let total = decimal(0);
  // PHASE 2.2 (#64): TRY-dışı satır toplama girmez — `weightedNetDetailed` sayısını verir.
  for (const l of partitionByCurrency(lines).comparable) {
    const amt = moneyOrNull(l.amount);
    if (amt === null) continue;
    const signed = l.direction === "inflow" ? decimal(amt) : decimal(amt).times(decimal(-1));
    total = total.plus(signed.times(decimal(l.confidence ?? 1)));
  }
  return Number(total.toFixed(2));
}

/** `weightedNet` + toplam dışı bırakılan TRY-dışı satır sayısı. */
export function weightedNetDetailed(
  lines: Array<{ amount: NumericInput; direction: "inflow" | "outflow"; confidence?: number | null; currency?: string | null }>,
): { total: number; foreignCount: number } {
  return { total: weightedNet(lines), foreignCount: partitionByCurrency(lines).foreignCount };
}
