// Phase 11B verification. Proves the decision-facts registry includes the
// complete Phase 11 key set, including cash_runway, and reports consume that
// facts layer without mutating finance/cashflow source tables.
import { Pool } from "pg";
import { loadDecisionFacts } from "../src/lib/facts/engine";
import { generateDaily } from "../src/lib/reports/engine";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
});
const fail = (m: string): never => { console.error("PHASE11B VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

const REQUIRED_FACTS = [
  "first_negative_month",
  "worst_cash_month",
  "cash_runway",
  "debt_pressure_months",
  "top_customer_concentration",
  "missing_amount_count",
  "overdue_payment_load",
  "check_maturity_30d",
  "loan_service_30d",
  "production_margin_loss",
  "stale_rate_flags",
  "unresolved_review_count",
];

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
  await pool.query(`truncate public.cashflow_months, public.cashflow_lines,
    public.reports, public.ai_response_snapshots, public.audit_logs restart identity cascade`);
  await pool.query(
    `insert into public.cashflow_months
       (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance, confidence, status)
     values
       ('2026-07-01', 100000, 80000, 60000, 20000, 120000, 'calculated', 'draft'),
       ('2026-08-01', 120000, 50000, 200000, -150000, -30000, 'calculated', 'draft'),
       ('2026-09-01', -30000, 60000, 120000, -60000, -90000, 'calculated', 'draft')`,
  );

  const before = await financeFingerprint();
  const facts = await loadDecisionFacts(pool, "2026-07-08");
  const keys = facts.map((f) => f.key);
  const missing = REQUIRED_FACTS.filter((k) => !keys.includes(k));
  if (missing.length > 0) fail(`missing decision facts: ${missing.join(",")}`);

  const runway = facts.find((f) => f.key === "cash_runway") ?? fail("cash_runway fact missing");
  if (runway.value !== "1 ay" || runway.severity !== "critical")
    fail(`unexpected cash_runway value/severity: ${runway.value}/${runway.severity}`);
  if (runway.sourceHref !== "/cashflow" || runway.confidence !== "calculated")
    fail("cash_runway must be calculated and source-linked to /cashflow");

  const report = await generateDaily(pool, "2026-07-08");
  const stored = (await q(`select meta from public.reports where id=$1`, [report.id]))[0]?.meta;
  const prompt = String(stored?.commentary_prompt ?? "");
  if (!prompt.includes("Nakit runway: 1 ay"))
    fail("daily report commentary prompt did not consume decision facts");

  const after = await financeFingerprint();
  if (before !== after) fail("decision facts/report prompt mutated finance/cashflow source tables");

  console.log(`decision facts ok count=${facts.length} runway=${runway.value} report=${report.id}`);
  console.log("PHASE11B VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
