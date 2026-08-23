// Phase 9D verification on REAL data (TEMİZ). Proves machine-minute allocation and
// finance-cost allocation are analytics-only: capacity demand reconciles to source
// G5/H5, operation-level capacity/overload is explicit, loan finance cost is allocated
// by demand minutes, idempotent, and core finance/cashflow tables are not mutated by
// the allocation step.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import { mapLoans } from "../src/lib/financing/engine";
import {
  loadFinanceCostAllocations,
  loadMachineMinuteAllocations,
  mapCapacitySheet,
  mapFinanceCostAllocations,
  mapMachineMinuteAllocations,
} from "../src/lib/production/engine";
import { ensureSystemActor } from "./db/seed-system-actor";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({
  connectionString: requireDisposableOwnerDatabaseUrl("phase9d:verify"),
});
const fail = (m: string): never => { console.error("PHASE9D VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const SRC = process.env.PHASE9D_SRC ?? "data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx";
const approx = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;
const requireRow = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    fail(message);
    throw new Error(message);
  }
  return row;
};

async function coreFinanceFingerprint(): Promise<string> {
  const rows = await q(`
    select 'payments' t, count(*) c, coalesce(sum(default_amount),0) s from public.payments
    union all select 'instances', count(*), coalesce(sum(amount),0) from public.payment_instances
    union all select 'cashflow', count(*), coalesce(sum(closing_balance),0) from public.cashflow_months
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
  await pool.query(`truncate public.source_workbooks, public.capacity_models, public.cost_models, public.cost_breakdown_lines, public.production_parts, public.part_profitability_runs, public.machine_roi_snapshots, public.machine_minute_allocations, public.finance_cost_allocations, public.loans, public.loan_installments, public.payments, public.payment_instances, public.cashflow_months, public.checks restart identity cascade`);

  const r = await importWorkbook(pool, readFileSync(SRC), "TEMİZ.xlsx", actorId);
  if (!r.ok) fail("import failed");
  const wb = r.workbookId;

  await pool.query(`update public.mapping_reviews set status='resolved', reviewed_at=now()
    where issue_type in ('stale_rate','missing_operation_time','capacity_minutes_reconciliation',
                         'break_even_reconciliation','capacity_rate_missing','cost_model_missing',
                         'loan_field_ambiguous','loan_term_mismatch')`);

  const cap = await mapCapacitySheet(pool, wb, actorId);
  if (cap.capacityCreated !== 1) fail(`expected 1 capacity model, got ${cap.capacityCreated}`);

  const m1 = await mapMachineMinuteAllocations(pool, wb, actorId);
  if (m1.created !== 3) fail(`expected 3 machine-minute rows, got ${m1.created}`);
  const m2 = await mapMachineMinuteAllocations(pool, wb, actorId);
  if (m2.created !== 0 || m2.skipped !== 3) fail("machine-minute allocation not idempotent");

  const minutes = await loadMachineMinuteAllocations(pool);
  const torna = requireRow(minutes.find((x) => x.operation_type === "torna"), "missing torna row");
  const freze = requireRow(minutes.find((x) => x.operation_type === "freze"), "missing freze row");
  const total = requireRow(minutes.find((x) => x.operation_type === "total"), "missing total row");

  const srcTotals = (await q(`
    select
      max(case when address='G5' then normalized_value end)::float8 as torna,
      max(case when address='H5' then normalized_value end)::float8 as freze
    from public.source_cells sc join public.source_sheets ss on ss.id=sc.sheet_id
    where ss.detected_type='capacity' and address in ('G5','H5')`))[0];
  const srcTorna = Number(srcTotals.torna);
  const srcFreze = Number(srcTotals.freze);
  if (!approx(torna.demand_minutes ?? -1, srcTorna, 20)) fail(`torna demand ${torna.demand_minutes} ≠ source G5 ${srcTorna}`);
  if (!approx(freze.demand_minutes ?? -1, srcFreze, 20)) fail(`freze demand ${freze.demand_minutes} ≠ source H5 ${srcFreze}`);
  if (!approx(total.demand_minutes ?? -1, srcTorna + srcFreze, 20)) fail("total demand does not reconcile to G5+H5");
  if ((torna.machine_count ?? 0) !== 3 || (freze.machine_count ?? 0) !== 1) fail("seeded machine counts not reflected");
  if ((freze.over_capacity_minutes ?? 0) <= 0) fail("freze overload should be visible in this workbook");
  console.log(`makine-dakika ✓ torna=${torna.demand_minutes} freze=${freze.demand_minutes} = kaynak G5/H5; freze açık=${freze.over_capacity_minutes}`);

  const loanMap = await mapLoans(pool, wb, actorId);
  if (loanMap.created !== 1) fail(`expected 1 loan, got ${loanMap.created}`);
  const beforeAllocation = await coreFinanceFingerprint();

  const f1 = await mapFinanceCostAllocations(pool, wb, actorId);
  if (f1.created !== 3) fail(`expected 3 finance allocations, got ${f1.created}`);
  const f2 = await mapFinanceCostAllocations(pool, wb, actorId);
  if (f2.created !== 0 || f2.skipped !== 3) fail("finance-cost allocation not idempotent");

  const finance = await loadFinanceCostAllocations(pool);
  const fTotal = requireRow(finance.find((x) => x.operation_type === "total"), "missing total finance allocation row");
  const fTorna = requireRow(finance.find((x) => x.operation_type === "torna"), "missing torna finance allocation row");
  const fFreze = requireRow(finance.find((x) => x.operation_type === "freze"), "missing freze finance allocation row");
  const loanCost = Number((await q(`select total_finance_cost::float8 c from public.loans limit 1`))[0].c);
  if (!approx(fTotal.allocated_finance_cost ?? -1, loanCost, 1)) fail("total finance allocation must equal loan finance cost");
  if (!approx((fTorna.allocated_finance_cost ?? 0) + (fFreze.allocated_finance_cost ?? 0), loanCost, 1.5))
    fail("operation allocations do not sum to loan finance cost");
  if ((fTotal.finance_cost_per_minute ?? 0) <= 0) fail("finance cost per minute missing");
  console.log(`finansman tahsisi ✓ toplam=${fTotal.allocated_finance_cost} TL, TL/dk=${fTotal.finance_cost_per_minute}`);

  const afterAllocation = await coreFinanceFingerprint();
  if (beforeAllocation !== afterAllocation) fail("allocation mutated core finance/cashflow tables");
  console.log("mali bütünlük ✓ (tahsis sadece machine_minute/finance_cost tablolarına yazar)");

  console.log("PHASE9D VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
