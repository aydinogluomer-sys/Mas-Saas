// Phase 13A verification on REAL data. Proves targeted scenario overlays are
// read-only: customer-income delay, outflow delay, factoring/discounting and
// minimum-financing metrics write only scenario_* + audit rows.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import { mapCashflowMonths } from "../src/lib/cashflow/engine";
import { mapAcceptedChecks, mapLoans } from "../src/lib/financing/engine";
import { createAndRun } from "../src/lib/scenarios/engine";
import { ensureSystemActor } from "./db/seed-system-actor";
import { requireOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({
  connectionString: requireOwnerDatabaseUrl(),
});
const fail = (m: string): never => { console.error("PHASE13A VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const SRC = process.env.PHASE13A_SRC ?? "data/source/mesaili_nakit_ak\u0131\u015f_tek_vardiya_TEM\u0130Z.xlsx";

async function coreFingerprint(): Promise<string> {
  const rows = await q(`
    select 'payments' t, count(*) c, coalesce(sum(default_amount),0) s from public.payments
    union all select 'instances', count(*), coalesce(sum(amount),0) from public.payment_instances
    union all select 'cashflow_months', count(*), coalesce(sum(closing_balance),0) from public.cashflow_months
    union all select 'cashflow_lines', count(*), coalesce(sum(amount),0) from public.cashflow_lines
    union all select 'checks', count(*), coalesce(sum(signed_amount),0) from public.checks
    union all select 'loans', count(*), coalesce(sum(total_finance_cost),0) from public.loans
    union all select 'installments', count(*), coalesce(sum(amount),0) from public.loan_installments
    order by t`);
  return JSON.stringify(rows);
}

async function main() {
  // audit_logs is append-only since 0022 (no UPDATE/DELETE/TRUNCATE, ever) — it is
  // deliberately NOT in the reset below. Each verify run gets a freshly created
  // disposable database instead, so the audit table starts empty without weakening
  // the invariant.
  // audit_logs.actor_id is an FK to public.users(id) since 0032; verify scripts run
  // without a session, so they attribute to the reserved "system" account.
  const actorId = await ensureSystemActor(pool);
  await pool.query(`truncate public.source_workbooks, public.cashflow_months, public.cashflow_snapshots, public.loans, public.loan_installments, public.payments, public.payment_instances, public.checks, public.scenarios, public.scenario_runs, public.scenario_run_lines, public.scenario_assumptions, public.scenario_comparisons restart identity cascade`);

  const imported = await importWorkbook(pool, readFileSync(SRC), "TEM\u0130Z.xlsx", actorId);
  if (!imported.ok) fail("import failed");
  const wb = imported.workbookId;
  await pool.query(`update public.mapping_reviews set status='resolved', reviewed_at=now()
    where issue_type in ('cashflow_identity_mismatch','cashflow_header_missing',
                         'loan_field_ambiguous','loan_term_mismatch','checks_header_not_found')`);
  await mapCashflowMonths(pool, wb, actorId);
  await mapAcceptedChecks(pool, wb, actorId);
  await mapLoans(pool, wb, actorId);

  const income = (await q(`
    select cl.label, to_char(cm.month_start,'YYYY-MM-DD') as month_start, cl.amount::float8 amount
    from public.cashflow_lines cl join public.cashflow_months cm on cm.id=cl.cashflow_month_id
    where cl.line_type='customer_income' and cl.amount is not null and cl.amount > 0
    order by cm.month_start, cl.amount desc limit 1`))[0];
  const futureIncome = (await q(`
    select cl.label, to_char(cm.month_start,'YYYY-MM-DD') as month_start, cl.amount::float8 amount
    from public.cashflow_lines cl join public.cashflow_months cm on cm.id=cl.cashflow_month_id
    where cl.line_type='customer_income' and cl.amount is not null and cl.amount > 0
    order by cm.month_start desc, cl.amount desc limit 1`))[0];
  const outflow = (await q(`
    select cl.label, to_char(cm.month_start,'YYYY-MM-DD') as month_start, cl.amount::float8 amount
    from public.cashflow_lines cl join public.cashflow_months cm on cm.id=cl.cashflow_month_id
    where cl.direction='outflow' and cl.amount is not null and cl.amount <> 0
    order by cm.month_start, abs(cl.amount) desc limit 1`))[0];
  const firstMonth = (await q(`select to_char(min(month_start),'YYYY-MM-DD') as m from public.cashflow_months`))[0]?.m;
  if (!income?.label || !futureIncome?.label || !outflow?.label || !firstMonth) fail("missing cashflow lines for targeted scenario");

  const before = await coreFingerprint();
  const run = await createAndRun(pool, {
    name: "Phase13A targeted delay + factoring",
    scenarioType: "combined_custom_scenario",
    assumptions: {
      targetIncomeLabel: String(income.label),
      targetIncomeDelayMonths: 1,
      targetOutflowLabel: String(outflow.label),
      targetOutflowDelayMonths: 1,
      factoringIncomeLabel: String(futureIncome.label),
      factoringAdvanceMonth: String(firstMonth).slice(0, 7),
      factoringFeePct: 0.04,
      includeDebtService: true,
    },
  }, actorId);

  const assumptionKeys = (await q(`select key from public.scenario_assumptions where run_id=$1 order by key`, [run.runId])).map((r) => r.key);
  for (const key of ["targetIncomeDelayMonths", "targetOutflowDelayMonths", "factoringAdvanceMonth", "factoringFeePct", "includeDebtService"])
    if (!assumptionKeys.includes(key)) fail(`missing assumption row ${key}`);

  const comparisonKeys = (await q(`select metric from public.scenario_comparisons where run_id=$1`, [run.runId])).map((r) => r.metric);
  if (!comparisonKeys.includes("minimum_financing_need")) fail("missing minimum_financing_need comparison");
  const changedLines = Number((await q(`select count(*)::int n from public.scenario_run_lines where run_id=$1 and abs(coalesce(delta,0)) > 0`, [run.runId]))[0].n);
  if (changedLines <= 0) fail("targeted overlays produced no scenario delta");
  const audit = (await q(`select (after_data->>'adjustmentCount')::int n from public.audit_logs where action='run_scenario' order by created_at desc limit 1`))[0];
  if (!audit || audit.n <= 0) fail("adjustment count not audited");

  const after = await coreFingerprint();
  if (before !== after) fail("scenario mutated core finance/cashflow tables");
  console.log(`targeted overlays ok run=${run.runId} changed_months=${changedLines} adjustments=${audit.n}`);
  console.log("PHASE13A VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
