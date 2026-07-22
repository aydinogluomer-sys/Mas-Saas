// Phase 8 scenario engine. READ-ONLY over the baseline: reads cashflow_months (+ Phase-5
// debt service), applies the pure scenario overlay, and writes ONLY to scenario_* tables
// (+ audit_logs). It never mutates payments/instances/cashflow/checks/loans/reminders/
// reports/production. Every run stores its explicit assumptions and the baseline it used.

import type { Pool, PoolClient } from "pg";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { loadApprovedExternalAssumptions, type ExternalAssumption } from "@/lib/external-assumptions/engine";
import { debtServiceByMonth } from "@/lib/financing/rules";
import { loadMaturityItems } from "@/lib/financing/engine";
import type { CashMonth } from "@/lib/radar/rules";
import {
  applyScenario,
  buildScenarioInsights,
  compareScenarioToBaseline,
  scenarioConfidence,
  type ScenarioAdjustment,
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

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "i")
    .toLowerCase()
    .trim();
}

function addMonthsISO(monthStart: string, months: number): string {
  const [y, m] = monthStart.slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function monthStart(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

function matchesNeedle(needle: string | null | undefined, ...hay: Array<string | null | undefined>): boolean {
  const n = norm(needle ?? "");
  if (!n) return false;
  return hay.some((h) => norm(h ?? "").includes(n));
}

interface CashflowLineLite {
  monthStart: string;
  lineType: string;
  direction: string;
  label: string | null;
  partyName: string | null;
  amount: number;
}

interface ScenarioExternalContext {
  assumptionType: string;
  label: string;
  value: number;
  unit: string;
  currency: string;
  sourceName: string;
  sourceDate: string;
  sourceHref: string;
}

async function loadCashflowLines(pool: Pool): Promise<CashflowLineLite[]> {
  const r = await pool.query(
    `select to_char(cm.month_start,'YYYY-MM-DD') as "monthStart",
            cl.line_type as "lineType", cl.direction, cl.label,
            p.name as "partyName", cl.amount::float8 as amount
     from public.cashflow_lines cl
     join public.cashflow_months cm on cm.id=cl.cashflow_month_id
     left join public.parties p on p.id=cl.party_id
     where cl.amount is not null
     order by cm.month_start, cl.label`,
  );
  return r.rows as CashflowLineLite[];
}

async function buildScenarioAdjustments(pool: Pool, a: ScenarioAssumptions): Promise<ScenarioAdjustment[]> {
  const adjustments: ScenarioAdjustment[] = [];
  const lines = await loadCashflowLines(pool);

  const incomeDelay = Math.max(0, Math.round(a.targetIncomeDelayMonths ?? 0));
  if (incomeDelay > 0 && a.targetIncomeLabel) {
    for (const l of lines) {
      if (l.lineType !== "customer_income") continue;
      if (!matchesNeedle(a.targetIncomeLabel, l.label, l.partyName)) continue;
      const amount = Math.abs(l.amount);
      adjustments.push({ monthStart: l.monthStart, incomeDelta: -amount, note: `delay income ${a.targetIncomeLabel}` });
      adjustments.push({ monthStart: addMonthsISO(l.monthStart, incomeDelay), incomeDelta: amount, note: `receive delayed income ${a.targetIncomeLabel}` });
    }
  }

  const outflowDelay = Math.max(0, Math.round(a.targetOutflowDelayMonths ?? 0));
  if (outflowDelay > 0 && a.targetOutflowLabel) {
    for (const l of lines) {
      if (l.direction !== "outflow" && l.direction !== "out") continue;
      if (!matchesNeedle(a.targetOutflowLabel, l.label, l.partyName)) continue;
      const amount = Math.abs(l.amount);
      adjustments.push({ monthStart: l.monthStart, expenseDelta: -amount, note: `delay outflow ${a.targetOutflowLabel}` });
      adjustments.push({ monthStart: addMonthsISO(l.monthStart, outflowDelay), expenseDelta: amount, note: `pay delayed outflow ${a.targetOutflowLabel}` });
    }
  }

  const advanceMonth = monthStart(a.factoringAdvanceMonth);
  const feePct = Math.max(0, a.factoringFeePct ?? 0);
  if (advanceMonth && a.factoringIncomeLabel) {
    for (const l of lines) {
      if (l.lineType !== "customer_income") continue;
      if (l.monthStart <= advanceMonth) continue;
      if (!matchesNeedle(a.factoringIncomeLabel, l.label, l.partyName)) continue;
      const amount = Math.abs(l.amount);
      const fee = amount * feePct;
      adjustments.push({ monthStart: l.monthStart, incomeDelta: -amount, note: `factor income ${a.factoringIncomeLabel}` });
      adjustments.push({ monthStart: advanceMonth, incomeDelta: amount - fee, expenseDelta: fee, note: `factoring advance ${a.factoringIncomeLabel}` });
    }
  }

  return adjustments;
}

export interface OptimizationCandidate {
  key: string;
  label: string;
  assumptions: ScenarioAssumptions;
  finalCash: number | null;
  finalDelta: number | null;
  maxCashGap: number | null;
  baselineFirstNegative: string | null;
  firstNegative: string | null;
  confidence: "high" | "medium" | "low";
}

export async function estimateOptimizationCandidates(pool: Pool): Promise<OptimizationCandidate[]> {
  const baseline: CashMonth[] = await loadCashMonths(pool);
  if (baseline.length === 0) return [];

  const items = await loadMaturityItems(pool);
  const debt = debtServiceByMonth(items).map((d) => ({ monthStart: d.monthStart, knownOutflow: d.knownOutflow }));

  const candidates: Array<{ key: string; label: string; assumptions: ScenarioAssumptions }> = [
    {
      key: "delay_cagdas_1m",
      label: "Odeme erteleme: Cagdas 1 ay",
      assumptions: { targetOutflowLabel: "Cagdas", targetOutflowDelayMonths: 1 },
    },
    {
      key: "factor_hpt",
      label: "Cek/faktoring: Hpt tahsilati one cek",
      assumptions: { factoringIncomeLabel: "Hpt", factoringAdvanceMonth: baseline[0].monthStart.slice(0, 7), factoringFeePct: 0.04 },
    },
    {
      key: "income_plus_10",
      label: "Gelir artisi: +%10",
      assumptions: { revenuePct: 0.1 },
    },
    {
      key: "combo_delay_plus_factor",
      label: "Kombinasyon: Cagdas ertele + Hpt faktoring",
      assumptions: {
        targetOutflowLabel: "Cagdas",
        targetOutflowDelayMonths: 1,
        factoringIncomeLabel: "Hpt",
        factoringAdvanceMonth: baseline[0].monthStart.slice(0, 7),
        factoringFeePct: 0.04,
      },
    },
  ];

  const out: OptimizationCandidate[] = [];
  for (const c of candidates) {
    const adj = await buildScenarioAdjustments(pool, c.assumptions);
    const months = applyScenario(baseline, c.assumptions, debt, adj);
    const cmp = compareScenarioToBaseline(months);
    out.push({
      key: c.key,
      label: c.label,
      assumptions: c.assumptions,
      finalCash: cmp.scenarioFinalCash,
      finalDelta: cmp.finalDelta,
      maxCashGap: cmp.maxCashGap,
      baselineFirstNegative: cmp.baselineFirstNegative,
      firstNegative: cmp.scenarioFirstNegative,
      confidence: scenarioConfidence(cmp),
    });
  }

  return out.sort((a, b) => {
    const aGap = a.maxCashGap ?? Number.POSITIVE_INFINITY;
    const bGap = b.maxCashGap ?? Number.POSITIVE_INFINITY;
    if (aGap !== bGap) return aGap - bGap;
    const aFinal = a.finalCash ?? Number.NEGATIVE_INFINITY;
    const bFinal = b.finalCash ?? Number.NEGATIVE_INFINITY;
    return bFinal - aFinal;
  });
}

function toScenarioExternalContext(a: ExternalAssumption): ScenarioExternalContext {
  return {
    assumptionType: a.assumption_type,
    label: a.label,
    value: a.value_numeric,
    unit: a.unit,
    currency: a.currency,
    sourceName: a.source_name,
    sourceDate: a.source_date,
    sourceHref: "/assumptions",
  };
}

async function loadScenarioExternalContext(pool: Pool): Promise<ScenarioExternalContext[]> {
  const approved = await loadApprovedExternalAssumptions(pool);
  return approved.map(toScenarioExternalContext);
}

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
  if (a.targetIncomeLabel && a.targetIncomeDelayMonths != null && a.targetIncomeDelayMonths !== 0)
    rows.push({ key: "targetIncomeDelayMonths", value: a.targetIncomeDelayMonths, unit: "ay", description: `Hedef gelir gecikmesi: ${a.targetIncomeLabel}` });
  if (a.targetOutflowLabel && a.targetOutflowDelayMonths != null && a.targetOutflowDelayMonths !== 0)
    rows.push({ key: "targetOutflowDelayMonths", value: a.targetOutflowDelayMonths, unit: "ay", description: `Hedef gider/odeme ertelemesi: ${a.targetOutflowLabel}` });
  if (a.factoringIncomeLabel && a.factoringAdvanceMonth)
    rows.push({ key: "factoringAdvanceMonth", value: null, unit: "ay", description: `Faktoring/iskonto advance: ${a.factoringIncomeLabel} -> ${a.factoringAdvanceMonth}` });
  if (a.factoringFeePct != null && a.factoringFeePct !== 0)
    rows.push({ key: "factoringFeePct", value: a.factoringFeePct, unit: "oran", description: "Faktoring/iskonto maliyeti" });
  return rows;
}

function externalContextRows(ctx: ScenarioExternalContext[]): Array<{ key: string; value: number | null; unit: string; description: string }> {
  return ctx.map((a) => ({
    key: `external:${a.assumptionType}`,
    value: a.value,
    unit: a.unit,
    description: `Dis varsayim: ${a.label} (${a.sourceName} / ${a.sourceDate})`,
  }));
}

const comparisonRows = (c: ScenarioComparison): Array<{ metric: string; base: number | null; scen: number | null; delta: number | null }> => [
  { metric: "final_cash", base: c.baselineFinalCash, scen: c.scenarioFinalCash, delta: c.finalDelta },
  { metric: "worst_balance", base: null, scen: c.worstBalance, delta: null },
  { metric: "max_cash_gap", base: null, scen: c.maxCashGap, delta: null },
  { metric: "minimum_financing_need", base: null, scen: c.maxCashGap, delta: null },
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
  const adjustments = await buildScenarioAdjustments(pool, assumptions);
  const externalContext = await loadScenarioExternalContext(pool);
  const storedAssumptions = externalContext.length > 0 ? { ...assumptions, externalContext } : assumptions;

  const months = applyScenario(baseline, assumptions, debt, adjustments);
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
        scenarioId, JSON.stringify(storedAssumptions),
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
    for (const ar of [...assumptionRows(assumptions), ...externalContextRows(externalContext)]) {
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
    await audit(client, "run_scenario", runId, { scenarioId, assumptions: storedAssumptions, adjustmentCount: adjustments.length, externalContextCount: externalContext.length, finalDelta: comparison.finalDelta, confidence });
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
     where r.archived_at is null
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
