// Phase 14D verification. Proves approved external assumptions feed read-only
// facts/AI/scenario context, pending internet inputs stay gated, and finance
// source tables are not mutated by that decision-context usage.
import { Pool } from "pg";
import { answerQuestion } from "../src/lib/ai/engine";
import { createExternalAssumption } from "../src/lib/external-assumptions/engine";
import { loadDecisionFacts } from "../src/lib/facts/engine";
import { createAndRun } from "../src/lib/scenarios/engine";

process.env.AI_FORCE_DETERMINISTIC = "1";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
});
const fail = (m: string): never => { console.error("PHASE14D VERIFY FAIL:", m); process.exit(1); };
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

async function ensureBaseline() {
  const n = Number((await q(`select count(*)::int n from public.cashflow_months`))[0]?.n ?? 0);
  if (n > 0) return;
  await pool.query(
    `insert into public.cashflow_months
       (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance, confidence, status)
     values
       ('2035-01-01',100000,90000,80000,10000,110000,'calculated','draft'),
       ('2035-02-01',110000,90000,85000,5000,115000,'calculated','draft')
     on conflict (month_start) do nothing`,
  );
}

async function main() {
  await ensureBaseline();
  await pool.query(`truncate public.external_assumptions, public.scenario_assumptions,
    public.scenario_comparisons, public.scenario_run_lines, public.scenario_runs,
    public.scenarios, public.ai_response_snapshots, public.audit_logs restart identity cascade`);
  const before = await financeFingerprint();

  const energyId = await createExternalAssumption(pool, {
    assumptionType: "energy_cost",
    label: "Elektrik birim maliyet varsayimi",
    valueNumeric: 4.2,
    unit: "TRY/kWh",
    currency: "TRY",
    sourceKind: "manual",
    sourceName: "MAS manuel varsayim",
    sourceDate: "2026-07-08",
  });
  if (!energyId) fail("approved manual external assumption not created");

  const pendingLoanRateId = await createExternalAssumption(pool, {
    assumptionType: "loan_rate",
    label: "Piyasa kredi orani pending",
    valueNumeric: 48,
    unit: "percent",
    currency: "TRY",
    sourceKind: "internet",
    sourceName: "ornek internet kaynagi",
    sourceUrl: "https://example.com/rates",
    sourceDate: "2026-07-08",
  });
  if (!pendingLoanRateId) fail("pending internet external assumption not created");

  const facts = await loadDecisionFacts(pool, "2026-07-08");
  if (!facts.some((f) => f.key === "external_energy_cost" && f.sourceHref === "/assumptions"))
    fail("approved external assumption did not become a decision fact");
  if (facts.some((f) => f.key === "external_loan_rate"))
    fail("pending internet assumption must not become a decision fact");

  const answer = await answerQuestion(pool, {
    question: "Enerji maliyeti varsayimi nedir?",
    forceDeterministic: true,
  });
  if (!answer.sourceFactKeys.includes("external_energy_cost"))
    fail(`AI answer did not cite external energy fact: ${answer.sourceFactKeys.join(",")}`);
  if (answer.sourceFactKeys.includes("external_loan_rate"))
    fail("AI answer cited pending loan-rate assumption");

  const run = await createAndRun(pool, {
    name: "Dis varsayim baglam smoke",
    scenarioType: "combined_custom_scenario",
    assumptions: { includeDebtService: true },
  });
  const scenarioRows = await q(`select key, description from public.scenario_assumptions where run_id=$1 order by key`, [run.runId]);
  if (!scenarioRows.some((r) => r.key === "external:energy_cost" && /MAS manuel/.test(r.description)))
    fail("scenario run did not disclose approved external energy assumption");
  if (scenarioRows.some((r) => r.key === "external:loan_rate"))
    fail("scenario run disclosed pending loan-rate assumption");

  const contextCount = Number((await q(
    `select jsonb_array_length(coalesce(assumptions->'externalContext','[]'::jsonb))::int n
     from public.scenario_runs where id=$1`,
    [run.runId],
  ))[0]?.n ?? 0);
  if (contextCount !== 1) fail(`expected exactly 1 external context row in scenario JSON, got ${contextCount}`);

  const after = await financeFingerprint();
  if (before !== after) fail("external decision context mutated finance/cashflow source tables");

  console.log(`external context ok fact=${energyId} ai=${answer.id} run=${run.runId}`);
  console.log("PHASE14D VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
