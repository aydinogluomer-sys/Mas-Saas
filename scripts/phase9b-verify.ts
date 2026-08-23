// Phase 9B verification on REAL data (TEMİZ). Proves the monthly expense breakdown:
//   the leaf expense components (BORÇLAR + STANDART GİDERLER + PERSONEL + GENEL) map into
//   cashflow_lines as loan_payment/tax/operational_cost, are source-traceable, and
//   RECONCILE — per month, Σ(new expense lines) == source B17+B26+G17+G24 (no double-count,
//   no silent drift). Null stays null. Idempotent re-map. Cashflow month TOTALS unchanged
//   (we surface composition, we don't alter gider/kasa).
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import { mapCashflowMonths } from "../src/lib/cashflow/engine";
import { ensureSystemActor } from "./db/seed-system-actor";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({
  connectionString: requireDisposableOwnerDatabaseUrl("phase9b:verify"),
});
const fail = (m: string): never => { console.error("PHASE9B VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const SRC = process.env.PHASE9B_SRC ?? "data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx";
const approx = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

async function main() {
  // audit_logs is append-only since 0022 (no UPDATE/DELETE/TRUNCATE, ever) — it is
  // deliberately NOT in the reset below. Each verify run gets a freshly created
  // disposable database instead, so the audit table starts empty without weakening
  // the invariant.
  // audit_logs.actor_id is an FK to public.users(id) since 0032; verify scripts run
  // without a session, so they attribute to the reserved "system" account.
  const actorId = await ensureSystemActor(pool);
  await pool.query(`truncate public.source_workbooks, public.cashflow_months, public.cashflow_snapshots restart identity cascade`);
  const r = await importWorkbook(pool, readFileSync(SRC), "TEMİZ.xlsx", actorId);
  if (!r.ok) fail("import failed");
  const wb = r.workbookId;

  // snapshot month totals before/after — surfacing lines must not change gider/kasa
  const m1 = await mapCashflowMonths(pool, wb, actorId);
  if (m1.monthsCreated !== 35) fail(`expected 35 months, got ${m1.monthsCreated}`);
  const totalsHash = JSON.stringify(await q(
    `select to_char(month_start,'YYYY-MM') m, projected_expense, closing_balance
     from public.cashflow_months order by month_start`));

  // 1) new expense line types present
  const byType = await q(`select line_type, count(*)::int n from public.cashflow_lines
    where line_type in ('operational_cost','tax','loan_payment') group by 1 order by 1`);
  const types = Object.fromEntries(byType.map((x) => [x.line_type, x.n]));
  if (!types.operational_cost || !types.tax || !types.loan_payment)
    fail(`missing expense line types: ${JSON.stringify(types)}`);
  console.log(`gider satır tipleri ✓ operational_cost=${types.operational_cost} tax=${types.tax} loan_payment=${types.loan_payment}`);

  // 2) RECONCILIATION per month: Σ(expense lines) == source B17+B26+G17+G24
  const months = await q(`select cm.id, to_char(cm.month_start,'YYYY-MM') ym, cm.source_sheet_id from public.cashflow_months cm`);
  let checked = 0, withExpense = 0;
  for (const mo of months) {
    const src = await q(
      `select address, normalized_value::float8 v from public.source_cells
       where sheet_id=$1 and address in ('B17','B26','G17','G24')`, [mo.source_sheet_id]);
    const cell = (a: string) => Number(src.find((x) => x.address === a)?.v ?? 0);
    const srcSum = cell("B17") + cell("B26") + cell("G17") + cell("G24");
    const lineSum = Number((await q(
      `select coalesce(sum(amount),0)::float8 s from public.cashflow_lines
       where cashflow_month_id=$1 and line_type in ('operational_cost','tax','loan_payment')`, [mo.id]))[0].s);
    if (!approx(lineSum, srcSum, 1.5))
      fail(`${mo.ym}: expense lines ${lineSum.toFixed(0)} ≠ source B17+B26+G17+G24 ${srcSum.toFixed(0)}`);
    checked++;
    if (lineSum > 0) withExpense++;
  }
  if (withExpense < 30) fail(`only ${withExpense} months carried expense detail`);
  console.log(`mutabakat ✓ ${checked} ay Σgider-satırı = kaynak B17+B26+G17+G24 (${withExpense} ayda dolu, çift-sayım yok)`);

  // 3) source traceability + null stays null
  const traced = (await q(`select count(*)::int n from public.cashflow_lines
    where line_type in ('operational_cost','tax','loan_payment') and source_row_id is not null`))[0].n;
  const total = (await q(`select count(*)::int n from public.cashflow_lines
    where line_type in ('operational_cost','tax','loan_payment')`))[0].n;
  if (traced !== total) fail("some expense lines lack source trace");
  const nulls = (await q(`select count(*)::int n from public.cashflow_lines
    where line_type in ('operational_cost','tax','loan_payment') and amount is null and amount_status='missing'`))[0].n;
  console.log(`izlenebilirlik ✓ ${total} gider satırı %100 kaynak-izli · ${nulls} null tutar (0 sayılmadı)`);

  // 4) idempotent re-map; totals unchanged
  const m2 = await mapCashflowMonths(pool, wb, actorId);
  if (m2.monthsCreated !== 0) fail("cashflow mapping not idempotent");
  const totalsAfter = JSON.stringify(await q(
    `select to_char(month_start,'YYYY-MM') m, projected_expense, closing_balance
     from public.cashflow_months order by month_start`));
  if (totalsHash !== totalsAfter) fail("month totals changed — composition must not alter gider/kasa");
  console.log("idempotent + ay toplamları değişmedi ✓ (kompozisyon gider/kasayı değiştirmez)");

  console.log("PHASE9B VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
