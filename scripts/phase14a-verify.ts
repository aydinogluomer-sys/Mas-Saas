// Phase 14A verification on REAL data. Proves the data-quality center and
// action workflow are operational-only: mapping reviews can become tasks, home
// actions can become tasks, status changes are audited, and finance/cashflow
// source-of-truth tables are not mutated.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import {
  createActionFromHomeSignal,
  createActionFromReview,
  createManualAction,
  loadDataQualityCenter,
  setActionStatus,
} from "../src/lib/data-quality/engine";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
});
const fail = (m: string): never => { console.error("PHASE14A VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const SRC = process.env.PHASE14A_SRC ?? "data/source/mesaili_nakit_ak\u0131\u015f_tek_vardiya_TEM\u0130Z.xlsx";

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
  await pool.query(`truncate public.source_workbooks, public.payments, public.payment_instances,
    public.cashflow_months, public.checks, public.loans, public.loan_installments,
    public.action_items, public.audit_logs restart identity cascade`);

  const imported = await importWorkbook(pool, readFileSync(SRC), "TEM\u0130Z.xlsx");
  if (!imported.ok || imported.reviewsInserted === 0) fail("import did not create mapping reviews");
  const review = (await q(`
    select id, issue_type, severity from public.mapping_reviews
    where workbook_id=$1 and status='open'
    order by case severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end
    limit 1`, [imported.workbookId]))[0];
  if (!review?.id) fail("missing open review to task");

  const before = await financeFingerprint();
  const reviewAction1 = await createActionFromReview(pool, review.id);
  const reviewAction2 = await createActionFromReview(pool, review.id);
  if (!reviewAction1 || reviewAction1 !== reviewAction2) fail("review action must be idempotent while open");

  const homeAction1 = await createActionFromHomeSignal(pool, {
    title: "Kasa negatif aya dusuyor - finansman planla",
    severity: "high",
    sourceFactKey: "first_negative_month",
    sourceHref: "/cashflow",
  });
  const homeAction2 = await createActionFromHomeSignal(pool, {
    title: "duplicate should reuse",
    severity: "high",
    sourceFactKey: "first_negative_month",
    sourceHref: "/cashflow",
  });
  if (homeAction1 !== homeAction2) fail("home action must be idempotent by source fact");

  const manual = await createManualAction(pool, { title: "Manuel veri kontrolu", severity: "medium", owner: "MAS" });
  if (!manual) fail("manual action not created");
  const manualId = manual as string;
  await setActionStatus(pool, manualId, "done");

  const center = await loadDataQualityCenter(pool);
  if (center.blockers.length === 0 || center.blockers.length > 5) fail("center blockers must be 1..5");
  if (center.actionOpenCount < 2) fail("expected open action items in center");

  const actionCount = Number((await q(`select count(*)::int n from public.action_items`))[0].n);
  if (actionCount !== 3) fail(`expected 3 action rows, got ${actionCount}`);
  const auditCount = Number((await q(`select count(*)::int n from public.audit_logs where entity_table='action_items'`))[0].n);
  if (auditCount < 4) fail("action workflow not audited");

  const after = await financeFingerprint();
  if (before !== after) fail("action workflow mutated finance/cashflow source tables");
  console.log(`data quality actions ok reviews=${imported.reviewsInserted} actions=${actionCount} audits=${auditCount}`);
  console.log("PHASE14A VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
