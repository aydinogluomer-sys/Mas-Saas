// Phase 14E verification. Proves the data-quality center surfaces workbook A/B
// differences, special dashboard sheets, formula counts, and cashflow header
// reconciliation without mutating finance/cashflow source tables.
import { Pool } from "pg";
import { loadDataQualityCenter } from "../src/lib/data-quality/engine";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
});
const fail = (m: string): never => { console.error("PHASE14E VERIFY FAIL:", m); process.exit(1); };
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
  await pool.query(`truncate public.source_workbooks, public.cashflow_months,
    public.cashflow_lines, public.action_items, public.external_assumptions,
    public.audit_logs restart identity cascade`);

  const newer = String((await q(
    `insert into public.source_workbooks (original_filename, imported_at, status)
     values ('workbook-a.xlsx','2026-07-08 10:00:00+03','parsed') returning id`,
  ))[0]?.id ?? "");
  const older = String((await q(
    `insert into public.source_workbooks (original_filename, imported_at, status)
     values ('workbook-b.xlsx','2026-07-07 10:00:00+03','parsed') returning id`,
  ))[0]?.id ?? "");
  if (!newer || !older) fail("workbook fixtures not inserted");

  const monthlyA = String((await q(
    `insert into public.source_sheets (workbook_id, sheet_name, sheet_name_normalized, sheet_index, detected_type, parse_confidence)
     values ($1,'temmuz 2026','temmuz 2026',0,'monthly_cashflow','high') returning id`,
    [newer],
  ))[0]?.id ?? "");
  await q(
    `insert into public.source_sheets (workbook_id, sheet_name, sheet_name_normalized, sheet_index, detected_type, parse_confidence)
     values
       ($1,'01_DASHBOARD','01_dashboard',1,'unknown','high'),
       ($1,'00_REHBER','00_rehber',2,'unknown','high'),
       ($1,'new_only','new_only',3,'unknown','high'),
       ($2,'temmuz 2026','temmuz 2026',0,'monthly_cashflow','high'),
       ($2,'old_only','old_only',1,'unknown','high')`,
    [newer, older],
  );
  if (!monthlyA) fail("monthly source sheet not inserted");

  await q(
    `insert into public.source_cells
       (workbook_id, sheet_id, row_index, column_index, address, raw_value, normalized_value, inferred_type, formula)
     values
       ($1,$2,1,2,'B1','100000','100000','number',null),
       ($1,$2,1,10,'J1','120000','120000','number',null),
       ($1,$2,2,2,'B2','formula','120000','number','B1+20000')`,
    [newer, monthlyA],
  );
  await q(
    `insert into public.cashflow_months
       (month_start, source_workbook_id, source_sheet_id, opening_balance, projected_income,
        projected_expense, monthly_delta, closing_balance, confidence, status)
     values ('2026-07-01',$1,$2,100000,80000,60000,20000,120000,'source_imported','draft')`,
    [newer, monthlyA],
  );

  const before = await financeFingerprint();
  const data = await loadDataQualityCenter(pool);

  if (!data.workbookDiff.ready) fail("workbook A/B diff not ready with two workbooks");
  const changed = data.workbookDiff.changedSheets.map((s) => `${s.sheet_name}:${s.side}`);
  if (!changed.includes("new_only:only_A")) fail(`missing only_A sheet diff: ${changed.join(",")}`);
  if (!changed.includes("old_only:only_B")) fail(`missing only_B sheet diff: ${changed.join(",")}`);
  if ((data.workbookDiff.a?.formula_count ?? 0) < 1) fail("formula count not surfaced for latest workbook");
  if (data.specialSheets.length < 2) fail("special dashboard/guide sheets not surfaced");

  const rec = data.cashflowReconciliation.find((r) => r.month_start === "2026-07-01") ?? fail("cashflow reconciliation row missing");
  if ((rec.opening_diff ?? 999) !== 0 || (rec.closing_diff ?? 999) !== 0)
    fail(`cashflow reconciliation diff expected 0, got opening=${rec.opening_diff} closing=${rec.closing_diff}`);

  const after = await financeFingerprint();
  if (before !== after) fail("data-quality A/B diff mutated finance/cashflow source tables");

  console.log(`data-quality A/B ok changed=${changed.join(",")} special=${data.specialSheets.length}`);
  console.log("PHASE14E VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
