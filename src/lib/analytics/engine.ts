// Faz 34 — the analysis engine: reads existing read-models, runs the pure analyses, stamps them.
//
// ═══ THIS MODULE RECOMPUTES NOTHING ═══
//
// Every number is READ from a read-model that an earlier phase owns — budget_vs_actual (Faz 28),
// working_capital_metrics (Faz 30), cashflow_months (Faz 5), invoices (Faz 21). The arithmetic
// here is only the analysis shape (splitting, sorting, bucketing, accumulating).
//
// The reason is the Faz 32 lesson: the moment an analysis screen computes DSO its own way, there
// are two DSOs in the system and they will eventually disagree. Column names were verified by
// introspection against a live database before this file was written, not assumed from the plan.
//
// NO @/lib/ai import, here or anywhere under src/lib/analytics — enforced repo-wide by
// phase34:verify from this phase onward.

import type { Pool } from "pg";
import { moneyOrNull } from "@/lib/money";
import { istanbulDateISO } from "@/lib/reports/rules";
import {
  ageingDistribution, cashBridge, paretoConcentration, varianceDecomposition,
  workingCapitalDecomposition,
  type AgeingRow, type AnalysisResult, type BridgeStep, type ParetoRow, type ParetoSummary,
  type VarianceRow, type WorkingCapitalComponent,
} from "./analyses";
import { periodOverPeriod, rollingWindow, type PeriodChange, type PeriodComparison, type RollingPoint, type RollingWindow } from "./periods";
import { buildStamp, type ReproducibilityStamp } from "./reproducibility";

/** Every analysis returns its result together with the stamp that makes it reproducible. */
export interface StampedAnalysis<T> {
  result: AnalysisResult<T>;
  stamp: ReproducibilityStamp;
}

const nowISO = () => new Date().toISOString();

/* ── 1. variance decomposition ──────────────────────────────────────────────────────────── */

export async function runVarianceDecomposition(
  pool: Pool, asOf = istanbulDateISO(),
): Promise<StampedAnalysis<VarianceRow>> {
  const rows = await pool.query(
    `select budget_line_id, coalesce(cost_center_name, department_name, project_name, budget_name)
             as label,
           budget_amount, actual_amount
       from public.budget_vs_actual
      order by budget_line_id`);
  const result = varianceDecomposition(rows.rows.map((r) => ({
    key: String(r.budget_line_id),
    label: String(r.label ?? "Adsız bütçe satırı"),
    budget: moneyOrNull(r.budget_amount),
    actual: moneyOrNull(r.actual_amount),
  })));
  const stamp = buildStamp("variance_decomposition", {
    rowCounts: { budget_vs_actual: rows.rowCount ?? 0 }, asOf, sourceCutoff: null,
  }, nowISO());
  return { result, stamp };
}

/* ── 2. Pareto concentration ────────────────────────────────────────────────────────────── */

export async function runParetoConcentration(
  pool: Pool, asOf = istanbulDateISO(), threshold = 0.8,
): Promise<StampedAnalysis<ParetoRow> & { summary: ParetoSummary | null }> {
  // Open sales exposure per counterparty. Non-negative by construction, which is what the Pareto
  // function requires — a share of a total that can cancel itself out is meaningless.
  const rows = await pool.query(
    `select p.id as party_id, p.name,
            sum(v.gross_amount - coalesce(v.allocated_amount, 0)) as exposure
       from public.invoices v
       join public.parties p on p.id = v.party_id
      where v.direction = 'sales' and v.status in ('open', 'partial')
      group by p.id, p.name
     having sum(v.gross_amount - coalesce(v.allocated_amount, 0)) > 0
      order by p.id`);
  const pareto = paretoConcentration(rows.rows.map((r) => ({
    key: String(r.party_id), label: String(r.name), value: moneyOrNull(r.exposure),
  })), threshold);
  const stamp = buildStamp("pareto_concentration", {
    rowCounts: { invoices_open_sales_parties: rows.rowCount ?? 0 }, asOf, sourceCutoff: null,
  }, nowISO());
  return { ...pareto, result: pareto, stamp } as StampedAnalysis<ParetoRow> & { summary: ParetoSummary | null };
}

/* ── 3. working capital decomposition ───────────────────────────────────────────────────── */

export async function runWorkingCapitalDecomposition(
  pool: Pool, asOf = istanbulDateISO(),
): Promise<StampedAnalysis<WorkingCapitalComponent> & { cycleDays: number | null; complete: boolean }> {
  const r = await pool.query(
    `select dso_days, dpo_days, dio_days, dio_unmeasurable_reason
       from public.working_capital_metrics`);
  const row = r.rows[0] ?? {};
  const decomposed = workingCapitalDecomposition({
    dsoDays: row.dso_days == null ? null : Number(row.dso_days),
    dpoDays: row.dpo_days == null ? null : Number(row.dpo_days),
  });
  const stamp = buildStamp("working_capital_decomposition", {
    rowCounts: { working_capital_metrics: r.rowCount ?? 0 }, asOf, sourceCutoff: null,
  }, nowISO());
  return { ...decomposed, result: decomposed, stamp };
}

/* ── 4. cash bridge ─────────────────────────────────────────────────────────────────────── */

export async function runCashBridge(
  pool: Pool, fromMonth: string, toMonth: string, asOf = istanbulDateISO(),
): Promise<StampedAnalysis<BridgeStep> & { computedEnd: number; reconciles: boolean | null; difference: number | null }> {
  const rows = await pool.query(
    `select to_char(month_start,'YYYY-MM') as month, opening_balance, closing_balance,
            projected_income, projected_expense
       from public.cashflow_months
      where to_char(month_start,'YYYY-MM') >= $1 and to_char(month_start,'YYYY-MM') <= $2
      order by month_start`, [fromMonth, toMonth]);

  const first = rows.rows[0];
  const last = rows.rows[rows.rows.length - 1];
  const start = first ? moneyOrNull(first.opening_balance) : null;

  const movements = rows.rows.flatMap((r) => [
    { key: `${r.month}-in`, label: `${r.month} gelir`, value: moneyOrNull(r.projected_income) },
    {
      key: `${r.month}-out`, label: `${r.month} gider`,
      // Expense is stored positive; the bridge needs it signed. Negated once, here, rather than
      // at each call site where a forgotten minus would silently invert a chart.
      value: (() => { const v = moneyOrNull(r.projected_expense); return v == null ? null : -v; })(),
    },
  ]);

  const bridged = cashBridge({
    startLabel: `${fromMonth} açılış`, startValue: start ?? 0,
    endLabel: `${toMonth} kapanış`,
    reportedEndValue: last ? moneyOrNull(last.closing_balance) : null,
    movements,
  });
  const stamp = buildStamp("cash_bridge", {
    rowCounts: { cashflow_months: rows.rowCount ?? 0 }, asOf, sourceCutoff: null,
  }, nowISO());
  return { ...bridged, result: bridged, stamp };
}

/* ── 5. ageing distribution ─────────────────────────────────────────────────────────────── */

export async function runAgeingDistribution(
  pool: Pool, direction: "sales" | "purchase" = "sales", asOf = istanbulDateISO(),
): Promise<StampedAnalysis<AgeingRow>> {
  const rows = await pool.query(
    `select to_char(due_date,'YYYY-MM-DD') as due_date,
            (gross_amount - coalesce(allocated_amount, 0)) as remaining
       from public.invoices
      where direction = $1 and status in ('open', 'partial')`, [direction]);
  const result = ageingDistribution(rows.rows.map((r) => ({
    dueDate: (r.due_date as string | null) ?? null,
    amount: moneyOrNull(r.remaining),
  })), asOf);
  const stamp = buildStamp("ageing_distribution", {
    rowCounts: { [`invoices_open_${direction}`]: rows.rowCount ?? 0 }, asOf, sourceCutoff: null,
  }, nowISO());
  return { result, stamp };
}

/* ── 6 & 7. period-over-period and rolling trend over a monthly cash series ─────────────── */

export interface MonthlySeries {
  key: string;
  value: number | null;
}

/** Monthly net cash movement — the series both time analyses run on. */
export async function loadNetCashSeries(pool: Pool): Promise<MonthlySeries[]> {
  const rows = await pool.query(
    `select to_char(month_start,'YYYY-MM') as month, monthly_delta
       from public.cashflow_months order by month_start`);
  return rows.rows.map((r) => ({ key: r.month as string, value: moneyOrNull(r.monthly_delta) }));
}

export async function runPeriodOverPeriod(
  pool: Pool, comparison: PeriodComparison, asOf = istanbulDateISO(),
): Promise<StampedAnalysis<PeriodChange>> {
  const series = await loadNetCashSeries(pool);
  const rows = periodOverPeriod(series, comparison);
  const result: AnalysisResult<PeriodChange> = {
    analysisId: "period_over_period",
    rows,
    unknownCount: rows.filter((r) => r.unmeasurableReason != null).length,
    unmeasurableReason: rows.length === 0 ? "Aylık seri boş" : null,
  };
  const stamp = buildStamp("period_over_period", {
    rowCounts: { cashflow_months: series.length }, asOf, sourceCutoff: null,
  }, nowISO());
  return { result, stamp };
}

/**
 * Rolling window over a DAILY series.
 *
 * Payment instances rather than cashflow_months, because a 7-day rolling window over monthly rows
 * would be arithmetic with no meaning — the window has to be finer than the grain.
 */
export async function runRollingTrend(
  pool: Pool, window: RollingWindow, asOf = istanbulDateISO(),
): Promise<StampedAnalysis<RollingPoint>> {
  const rows = await pool.query(
    `select to_char(due_date,'YYYY-MM-DD') as day,
            sum(amount) filter (where amount is not null) as known_amount,
            count(*) filter (where amount is null)::int as unknown_rows
       from public.payment_instances
      where due_date >= (current_date - interval '400 days') and due_date <= current_date
        and status in ('unpaid','partial','paid','late')
      group by due_date order by due_date`);
  const series = rows.rows.map((r) => ({
    key: r.day as string,
    // A day whose rows all had unknown amounts is UNKNOWN, not zero.
    value: Number(r.unknown_rows) > 0 && r.known_amount == null ? null : moneyOrNull(r.known_amount) ?? 0,
  }));
  const points = rollingWindow(series, window, "sum");
  const result: AnalysisResult<RollingPoint> = {
    analysisId: "rolling_trend",
    rows: points,
    unknownCount: points.reduce((s, p) => s + p.unknownCount, 0),
    unmeasurableReason: points.length === 0 ? "Günlük seri boş" : null,
  };
  const stamp = buildStamp("rolling_trend", {
    rowCounts: { payment_instances_days: series.length }, asOf, sourceCutoff: null,
  }, nowISO());
  return { result, stamp };
}
