// Phase 13B verification. Proves the financing-optimization candidate ranking
// is a read-only estimator: it compares supported overlays, writes no scenario
// rows, and does not mutate finance/cashflow source tables.
import { Pool } from "pg";
import { estimateOptimizationCandidates } from "../src/lib/scenarios/engine";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
});
const fail = (m: string): never => { console.error("PHASE13B VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

async function financeFingerprint(): Promise<string> {
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
  await pool.query(`truncate public.cashflow_months, public.cashflow_lines, public.scenario_assumptions, public.scenario_comparisons, public.scenario_run_lines, public.scenario_runs, public.scenarios restart identity cascade`);

  const months = await q(
    `insert into public.cashflow_months
       (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance, confidence, status)
     values
       ('2026-07-01', 100000, 70000, 180000, -110000, -10000, 'calculated', 'draft'),
       ('2026-08-01', -10000, 220000, 120000, 100000, 90000, 'calculated', 'draft'),
       ('2026-09-01', 90000, 90000, 140000, -50000, 40000, 'calculated', 'draft')
     returning id, to_char(month_start,'YYYY-MM-DD') as month_start`,
  );
  const byMonth = new Map(months.map((m) => [m.month_start, m.id]));
  await pool.query(
    `insert into public.cashflow_lines (cashflow_month_id, line_type, direction, label, amount, amount_status)
     values
       ($1,'vendor_payment','outflow','Cagdas makina odemesi',80000,'known'),
       ($2,'customer_income','inflow','Hpt tahsilat',200000,'known'),
       ($3,'customer_income','inflow','Hpt tahsilat',70000,'known')`,
    [byMonth.get("2026-07-01"), byMonth.get("2026-08-01"), byMonth.get("2026-09-01")],
  );

  const before = await financeFingerprint();
  const candidates = await estimateOptimizationCandidates(pool);
  if (candidates.length !== 4) fail(`expected 4 optimization candidates, got ${candidates.length}`);
  for (const key of ["delay_cagdas_1m", "factor_hpt", "income_plus_10", "combo_delay_plus_factor"]) {
    if (!candidates.some((c) => c.key === key)) fail(`missing optimization candidate ${key}`);
  }
  for (let i = 1; i < candidates.length; i++) {
    const prev = candidates[i - 1].maxCashGap ?? Number.POSITIVE_INFINITY;
    const curr = candidates[i].maxCashGap ?? Number.POSITIVE_INFINITY;
    if (prev > curr) fail("optimization candidates are not sorted by lowest cash gap");
  }

  const scenarioRows = (await q(
    `select
       (select count(*)::int from public.scenarios) as scenarios,
       (select count(*)::int from public.scenario_runs) as runs,
       (select count(*)::int from public.scenario_run_lines) as lines`,
  ))[0];
  if (scenarioRows.scenarios !== 0 || scenarioRows.runs !== 0 || scenarioRows.lines !== 0)
    fail(`optimizer estimator wrote scenario rows: ${JSON.stringify(scenarioRows)}`);

  const after = await financeFingerprint();
  if (before !== after) fail("optimization estimator mutated finance/cashflow source tables");

  console.log(`optimization candidates ok best=${candidates[0].key} gap=${candidates[0].maxCashGap}`);
  console.log("PHASE13B VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
