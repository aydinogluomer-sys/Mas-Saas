// Phase 8 scenario engine. READ-ONLY over the baseline: reads cashflow_months (+ Phase-5
// debt service), applies the pure scenario overlay, and writes ONLY to scenario_* tables
// (+ audit_logs). It never mutates payments/instances/cashflow/checks/loans/reminders/
// reports/production. Every run stores its explicit assumptions and the baseline it used.

import type { Pool, PoolClient } from "pg";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { debtServiceByMonth } from "@/lib/financing/rules";
import { loadMaturityItems } from "@/lib/financing/engine";
import type { CashMonth } from "@/lib/radar/rules";
import {
  applyScenario,
  buildScenarioInsights,
  compareScenarioToBaseline,
  scenarioConfidence,
  type ScenarioAssumptions,
  type ScenarioComparison,
} from "./rules";

async function audit(client: PoolClient, action: string, entityId: string | null, after: unknown): Promise<void> {
  await client.query(
    `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
     values (null,$1,'scenario_runs',$2,null,$3)`,
    [action, entityId, JSON.stringify(after ?? null)],
  );
}

export type ScenarioType =
  | "revenue_up_down_percent" | "expense_up_down_percent" | "customer_delay_days"
  | "debt_service_overlay" | "capacity_utilization_change" | "efficiency_change"
  | "combined_custom_scenario";

export async function createScenario(
  pool: Pool,
  input: { name: string; description?: string; scenarioType: ScenarioType; baselineLabel?: string; baselineMonthCount?: number },
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query(
      `insert into public.scenarios (name, description, scenario_type, baseline_label, baseline_month_count)
       values ($1,$2,$3,$4,$5) returning id`,
      [input.name, input.description ?? null, input.scenarioType, input.baselineLabel ?? null, input.baselineMonthCount ?? null],
    );
    const id: string = ins.rows[0].id;
    await audit(client, "create_scenario", id, { name: input.name, type: input.scenarioType });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Disclosed assumption rows (explicit, never hidden) written per run. */
function assumptionRows(a: ScenarioAssumptions): Array<{ key: string; value: number | null; unit: string; description: string }> {
  const rows: Array<{ key: string; value: number | null; unit: string; description: string }> = [];
  if (a.revenuePct != null && a.revenuePct !== 0) rows.push({ key: "revenuePct", value: a.revenuePct, unit: "oran", description: "Gelir yüzde değişimi" });
  if (a.expensePct != null && a.expensePct !== 0) rows.push({ key: "expensePct", value: a.expensePct, unit: "oran", description: "Gider yüzde değişimi" });
  if (a.customerDelayMonths != null && a.customerDelayMonths !== 0) rows.push({ key: "customerDelayMonths", value: a.customerDelayMonths, unit: "ay", description: "Müşteri tahsilat gecikmesi" });
  if (a.capacityUtilizationPct != null && a.capacityUtilizationPct !== 0) rows.push({ key: "capacityUtilizationPct", value: a.capacityUtilizationPct, unit: "oran", description: "Kapasite kullanım değişimi (gelir vekili)" });
  if (a.efficiencyPct != null && a.efficiencyPct !== 0) rows.push({ key: "efficiencyPct", value: a.efficiencyPct, unit: "oran", description: "Verim değişimi (gider vekili)" });
  if (a.includeDebtService) rows.push({ key: "includeDebtService", value: 1, unit: "bayrak", description: "Borç-servisi (çek+taksit) gidere eklendi" });
  return rows;
}

const comparisonRows = (c: ScenarioComparison): Array<{ metric: string; base: number | null; scen: number | null; delta: number | null }> => [
  { metric: "final_cash", base: c.baselineFinalCash, scen: c.scenarioFinalCash, delta: c.finalDelta },
  { metric: "worst_balance", base: null, scen: c.worstBalance, delta: null },
  { metric: "max_cash_gap", base: null, scen: c.maxCashGap, delta: null },
];

export interface RunResult {
  runId: string;
  comparison: ScenarioComparison;
  insights: string[];
}

export async function runScenario(
  pool: Pool,
  scenarioId: string,
  assumptions: ScenarioAssumptions,
): Promise<RunResult> {
  // baseline is READ (never written)
  const baseline: CashMonth[] = await loadCashMonths(pool);
  const items = await loadMaturityItems(pool);
  const debt = debtServiceByMonth(items).map((d) => ({ monthStart: d.monthStart, knownOutflow: d.knownOutflow }));

  const months = applyScenario(baseline, assumptions, debt);
  const comparison = compareScenarioToBaseline(months);
  const confidence = scenarioConfidence(comparison);
  const insights = buildScenarioInsights(comparison, assumptions);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const runIns = await client.query(
      `insert into public.scenario_runs
         (scenario_id, assumptions, baseline_final_cash, scenario_final_cash, final_delta,
          baseline_first_negative, scenario_first_negative, worst_month, worst_balance,
          max_cash_gap, recovery_month, month_count, null_month_count, confidence, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [
        scenarioId, JSON.stringify(assumptions),
        comparison.baselineFinalCash, comparison.scenarioFinalCash, comparison.finalDelta,
        comparison.baselineFirstNegative, comparison.scenarioFirstNegative,
        comparison.worstMonth, comparison.worstBalance, comparison.maxCashGap, comparison.recoveryMonth,
        comparison.monthCount, comparison.nullMonthCount, confidence,
        insights.join(" · "),
      ],
    );
    const runId: string = runIns.rows[0].id;

    for (const m of months) {
      await client.query(
        `insert into public.scenario_run_lines
           (run_id, month_start, baseline_income, scenario_income, baseline_expense, scenario_expense,
            baseline_closing, scenario_closing, delta)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (run_id, month_start) do nothing`,
        [runId, m.monthStart, m.baselineIncome, m.scenarioIncome, m.baselineExpense, m.scenarioExpense,
         m.baselineClosing, m.scenarioClosing, m.delta],
      );
    }
    for (const ar of assumptionRows(assumptions)) {
      await client.query(
        `insert into public.scenario_assumptions (run_id, key, value_numeric, unit, description)
         values ($1,$2,$3,$4,$5)`,
        [runId, ar.key, ar.value, ar.unit, ar.description],
      );
    }
    for (const cr of comparisonRows(comparison)) {
      await client.query(
        `insert into public.scenario_comparisons (run_id, metric, baseline_value, scenario_value, delta)
         values ($1,$2,$3,$4,$5) on conflict (run_id, metric) do nothing`,
        [runId, cr.metric, cr.base, cr.scen, cr.delta],
      );
    }
    await audit(client, "run_scenario", runId, { scenarioId, assumptions, finalDelta: comparison.finalDelta, confidence });
    await client.query("commit");
    return { runId, comparison, insights };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Convenience: create a scenario and run it in one call (UI path). */
export async function createAndRun(
  pool: Pool,
  input: { name: string; scenarioType: ScenarioType; assumptions: ScenarioAssumptions },
): Promise<RunResult & { scenarioId: string }> {
  const baseline = await loadCashMonths(pool);
  const first = baseline[0]?.monthStart?.slice(0, 7);
  const last = baseline[baseline.length - 1]?.monthStart?.slice(0, 7);
  const scenarioId = await createScenario(pool, {
    name: input.name, scenarioType: input.scenarioType,
    baselineLabel: baseline.length ? `nakit akış ${baseline.length} ay ${first}..${last}` : "baz veri yok",
    baselineMonthCount: baseline.length,
  });
  const run = await runScenario(pool, scenarioId, input.assumptions);
  return { scenarioId, ...run };
}

export async function compareScenarioToBaselineRun(pool: Pool, runId: string) {
  return (await pool.query(
    `select metric, baseline_value::float8 as base, scenario_value::float8 as scen, delta::float8 as delta
     from public.scenario_comparisons where run_id=$1 order by metric`,
    [runId],
  )).rows;
}

export async function loadScenarioRun(pool: Pool, runId: string) {
  const run = await pool.query(
    `select r.id, r.scenario_id, s.name, s.scenario_type, s.baseline_label,
            to_char(r.run_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as run_at,
            r.assumptions, r.baseline_final_cash::float8 as base_final, r.scenario_final_cash::float8 as scen_final,
            r.final_delta::float8 as final_delta,
            to_char(r.baseline_first_negative,'YYYY-MM-DD') as base_first_neg,
            to_char(r.scenario_first_negative,'YYYY-MM-DD') as scen_first_neg,
            to_char(r.worst_month,'YYYY-MM-DD') as worst_month, r.worst_balance::float8 as worst_balance,
            r.max_cash_gap::float8 as max_gap, to_char(r.recovery_month,'YYYY-MM-DD') as recovery_month,
            r.month_count, r.null_month_count, r.confidence, r.notes
     from public.scenario_runs r join public.scenarios s on s.id=r.scenario_id where r.id=$1`,
    [runId],
  );
  if (run.rowCount === 0) return null;
  const lines = await pool.query(
    `select to_char(month_start,'YYYY-MM-DD') as month_start,
            baseline_income::float8 as base_inc, scenario_income::float8 as scen_inc,
            baseline_expense::float8 as base_exp, scenario_expense::float8 as scen_exp,
            baseline_closing::float8 as base_close, scenario_closing::float8 as scen_close, delta::float8 as delta
     from public.scenario_run_lines where run_id=$1 order by month_start`,
    [runId],
  );
  const assumptions = await pool.query(
    `select key, value_numeric::float8 as value, unit, description from public.scenario_assumptions where run_id=$1`,
    [runId],
  );
  return { run: run.rows[0], lines: lines.rows, assumptions: assumptions.rows };
}

export async function listScenarioRuns(pool: Pool) {
  const r = await pool.query(
    `select r.id, s.name, s.scenario_type, r.final_delta::float8 as final_delta, r.confidence,
            to_char(r.scenario_first_negative,'YYYY-MM-DD') as scen_first_neg,
            to_char(r.run_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as run_at
     from public.scenario_runs r join public.scenarios s on s.id=r.scenario_id
     order by r.run_at desc limit 50`,
  );
  return r.rows as Array<{ id: string; name: string; scenario_type: string; final_delta: number | null; confidence: string; scen_first_neg: string | null; run_at: string }>;
}

/** Safe: only removes scenario_* rows (cascade). Baseline is untouched. Audited. */
export async function deleteScenarioRun(pool: Pool, runId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from public.scenario_runs where id=$1`, [runId]);
    await audit(client, "delete_scenario_run", runId, { deleted: true });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
