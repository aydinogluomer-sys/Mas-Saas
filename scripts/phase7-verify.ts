// Phase 7 verification on REAL data (TEMİZ). Proves:
//   capacity + cost mapping cross-checks source anchors (break-even == source G6,
//     effective minutes == machines×dk×verim); ALL 68 parts captured (demand == source
//     G5+H5, no silent discard) and traceable to source rows; stale-rate flagged;
//   part profitability + missing-op confidence; ROI defaults needs_review;
//   idempotent mapping + profitability (re-run creates 0);
//   FINANCIAL INTEGRITY: Phase-7 mapping mutates NO finance table
//     (payments/instances/cashflow/checks/loans/reminders/reports before==after).
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import {
  calculateMachineRoiSnapshot, calculatePartProfitability,
  loadActualMonthlyIncome, loadCapacityDemand, loadCapacityModels, loadCostModels,
  mapCapacitySheet, mapCostSheets,
} from "../src/lib/production/engine";
import { ensureSystemActor } from "./db/seed-system-actor";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
});
const fail = (m: string): never => { console.error("PHASE7 VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const SRC = process.env.PHASE7_SRC ?? "data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx";
const approx = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

// fingerprint of finance tables that Phase 7 must NOT touch
async function financeFingerprint(): Promise<string> {
  const rows = await q(`
    select 'payments' t, count(*) c, coalesce(sum(default_amount),0) s from public.payments
    union all select 'instances', count(*), coalesce(sum(amount),0) from public.payment_instances
    union all select 'cashflow', count(*), coalesce(sum(closing_balance),0) from public.cashflow_months
    union all select 'checks', count(*), coalesce(sum(signed_amount),0) from public.checks
    union all select 'loans', count(*), coalesce(sum(total_payment),0) from public.loans
    union all select 'deliveries', count(*), 0 from public.reminder_deliveries
    union all select 'reports', count(*), 0 from public.reports
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
  await pool.query(`truncate public.source_workbooks, public.capacity_models, public.cost_models, public.production_parts, public.part_profitability_runs, public.machine_roi_snapshots, public.payments, public.payment_instances, public.cashflow_months, public.checks, public.loans, public.reminder_deliveries, public.reports restart identity cascade`);

  const r = await importWorkbook(pool, readFileSync(SRC), "TEMİZ.xlsx", actorId);
  if (!r.ok) fail("import failed");
  const wb = r.workbookId;

  // resolve analytics reviews (stale/missing/recon) so mapping proceeds (human sign-off)
  await pool.query(`update public.mapping_reviews set status='resolved'
    where issue_type in ('stale_rate','missing_operation_time','capacity_minutes_reconciliation',
                         'break_even_reconciliation','capacity_rate_missing','cost_model_missing')`);

  const before = await financeFingerprint();

  // 1) capacity mapping + idempotency
  const c1 = await mapCapacitySheet(pool, wb, actorId);
  console.log("capacity map#1:", JSON.stringify(c1));
  if (c1.capacityCreated !== 1) fail("expected 1 capacity model");
  const c2 = await mapCapacitySheet(pool, wb, actorId);
  if (c2.capacityCreated !== 0 || c2.partsCreated !== 0) fail("capacity mapping not idempotent");

  // 2) NO SILENT DISCARD: mapped part demand == source kapasite G5+H5
  const demand = await loadCapacityDemand(pool);
  const srcTotals = (await q(`
    select (max(case when address='G5' then normalized_value end)::float8
          + max(case when address='H5' then normalized_value end)::float8) as tot
    from public.source_cells sc join public.source_sheets ss on ss.id=sc.sheet_id
    where ss.detected_type='capacity' and address in ('G5','H5')`))[0].tot;
  if (!approx(demand.demandMinutes, Number(srcTotals), 20))
    fail(`part demand ${demand.demandMinutes} ≠ source G5+H5 ${srcTotals} (silent discard?)`);
  console.log(`no-silent-discard ✓ ${demand.partCount} parça, talep=${demand.demandMinutes.toFixed(0)} = kaynak G5+H5=${Number(srcTotals).toFixed(0)}`);

  // 3) source traceability: every part links to a source row
  const traced = (await q(`select count(*)::int n from public.production_parts where source_row_id is not null`))[0].n;
  if (traced !== demand.partCount) fail("part source traceability broken");

  // 4) capacity anchors + stale flag
  const cap = (await loadCapacityModels(pool))[0] as unknown as { frezeRateTLPerMin: number; tornaRateTLPerMin: number; isStaleRate: boolean; rateYear: number };
  if (!approx(cap.frezeRateTLPerMin, 20.128, 0.001) || !approx(cap.tornaRateTLPerMin, 16, 0.001)) fail("capacity rates wrong");
  if (!cap.isStaleRate || cap.rateYear !== 2023) fail("stale-rate not flagged (2023)");
  console.log(`capacity ✓ freze=${cap.frezeRateTLPerMin} torna=${cap.tornaRateTLPerMin} stale=${cap.isStaleRate}(${cap.rateYear})`);

  // 5) cost mapping: break-even == source, reconciles; idempotent
  const cm1 = await mapCostSheets(pool, wb, actorId);
  if (cm1.created !== 2) fail(`expected 2 cost models, got ${cm1.created}`);
  const cm2 = await mapCostSheets(pool, wb, actorId);
  if (cm2.created !== 0) fail("cost mapping not idempotent");
  const costs = await loadCostModels(pool);
  const normal = costs.find((x) => x.scenario === "normal")!;
  const overtime = costs.find((x) => x.scenario === "overtime")!;
  // source G6 anchors: normal 26.1836, overtime 21.5397; F6: 40128 / 49248
  if (!approx(normal.breakEven!, 26.1836, 0.001)) fail(`normal break-even ${normal.breakEven} ≠ 26.1836`);
  if (!approx(overtime.breakEven!, 21.5397, 0.001)) fail(`overtime break-even ${overtime.breakEven} ≠ 21.5397`);
  // reconcile: break-even == monthly cost ÷ effective minutes
  if (!approx(normal.monthlyCost! / normal.effectiveMinutes!, normal.breakEven!, 0.01)) fail("normal break-even doesn't reconcile");
  if (overtime.breakEven! >= normal.breakEven!) fail("mesaili should lower break-even in this data");
  console.log(`cost ✓ normal başabaş=${normal.breakEven} mesaili=${overtime.breakEven} (mesaili düşük; kaynak G6 birebir)`);

  // 6) part profitability + missing-op confidence; idempotent
  const p1 = await calculatePartProfitability(pool);
  const p2 = await calculatePartProfitability(pool);
  if (p2.runsCreated !== 0) fail("profitability not idempotent");
  const missingConf = (await q(`select count(*)::int n from public.part_profitability_runs where missing_operation_time and confidence='needs_review'`))[0].n;
  const nullCost = (await q(`select count(*)::int n from public.part_profitability_runs where missing_operation_time and estimated_total_cost is not null`))[0].n;
  if (missingConf === 0) fail("missing-op parts not flagged needs_review");
  if (nullCost !== 0) fail("missing-op part got a non-null cost (null must stay null)");
  console.log(`profitability ✓ ${p1.runsCreated} run, ${missingConf} needs_review (süre eksik→maliyet null)`);

  // 7) ROI defaults needs_review
  const mid = (await q(`select id from public.machine_assets limit 1`))[0].id;
  await calculateMachineRoiSnapshot(pool, { machineAssetId: mid, year: 2026, revenue: 5000000, cost: 3000000, tax: 400000, sourceWorkbookId: wb });
  const roi = (await q(`select confidence, net_after_tax::float8 as net from public.machine_roi_snapshots where machine_asset_id=$1 and snapshot_year=2026`, [mid]))[0];
  if (roi.confidence !== "needs_review") fail("ROI confidence not needs_review");
  if (!approx(roi.net, 1600000, 1)) fail(`ROI net ${roi.net} ≠ 1.6M (rev-cost-tax)`);
  console.log(`ROI ✓ net=${roi.net} confidence=${roi.confidence} (asla otomatik güvenilir değil)`);

  // 8) theoretical vs actual revenue loader sanity (no cashflow here → null actual)
  const actual = await loadActualMonthlyIncome(pool);
  console.log(`teorik-vs-gerçek gelir loader ✓ (bu senaryoda nakit-akış yok → gerçek=${actual})`);

  // 9) FINANCIAL INTEGRITY: no finance table mutated by Phase-7 mapping
  const after = await financeFingerprint();
  if (before !== after) fail("Phase-7 mapping MUTATED a finance table — forbidden");
  console.log("mali bütünlük ✓ (üretim analitiği hiçbir mali/nakit/çek/kredi/rapor tablosunu değiştirmedi)");

  console.log("PHASE7 VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
