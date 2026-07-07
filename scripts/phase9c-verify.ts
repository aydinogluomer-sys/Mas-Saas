// Phase 9C verification on REAL data (TEMİZ). Proves the `tablo` machine-ROI mapping:
//   PERSONAL/family data is NEVER written to any domain table (privacy) and is flagged
//   personal_data_mixed; the machine ROI (4 machines, 2025 P&L) maps only AFTER that
//   review is resolved (human sign-off); machine purchase costs update the seeded assets;
//   ROI stays needs_review; idempotent; FINANCIAL INTEGRITY unchanged.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import { loadMachineRoi, loadMachineRoiAggregate, mapMachineRoi } from "../src/lib/production/engine";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
});
const fail = (m: string): never => { console.error("PHASE9C VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const SRC = process.env.PHASE9C_SRC ?? "data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx";
const approx = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

async function financeFingerprint(): Promise<string> {
  const rows = await q(`
    select 'payments' t, count(*) c from public.payments
    union all select 'instances', count(*) from public.payment_instances
    union all select 'cashflow', count(*) from public.cashflow_months
    union all select 'checks', count(*) from public.checks
    union all select 'loans', count(*) from public.loans
    union all select 'cost_models', count(*) from public.cost_models order by t`);
  return JSON.stringify(rows);
}

async function main() {
  await pool.query(`truncate public.source_workbooks, public.machine_roi_snapshots,
    public.payments, public.payment_instances, public.cashflow_months, public.checks, public.loans, public.cost_models,
    public.audit_logs restart identity cascade`);
  // machine_assets keeps its 4 seeded rows (not truncated); reset their purchase_cost
  await pool.query(`update public.machine_assets set purchase_cost=null`);
  const r = await importWorkbook(pool, readFileSync(SRC), "TEMİZ.xlsx");
  if (!r.ok) fail("import failed");
  const wb = r.workbookId;

  // 1) personal_data_mixed flagged at import
  const pdm = (await q(`select count(*)::int n from public.mapping_reviews where issue_type='personal_data_mixed'`))[0].n;
  if (pdm === 0) fail("personal_data_mixed not flagged for tablo");
  console.log(`kişisel-veri bayrağı ✓ (${pdm} personal_data_mixed review)`);

  const before = await financeFingerprint();

  // 2) while the review is OPEN, machine ROI is blocked (nothing mapped)
  const blocked = await mapMachineRoi(pool, wb);
  if (blocked.perMachineSnapshots !== 0 || blocked.excluded.length === 0) fail("ROI should be blocked until review resolved");
  console.log(`bloke ✓ (kişisel-veri incelemesi açıkken makine ROI aktarılmıyor)`);

  // 3) human resolves the personal-data review → machine ROI maps (personal STILL excluded)
  await pool.query(`update public.mapping_reviews set status='resolved' where issue_type='personal_data_mixed'`);
  const m1 = await mapMachineRoi(pool, wb);
  if (m1.perMachineSnapshots < 4) fail(`expected ≥4 machine snapshots, got ${m1.perMachineSnapshots}`);
  if (!m1.aggregateSnapshot) fail("aggregate P&L snapshot missing");
  const m2 = await mapMachineRoi(pool, wb);
  if (m2.perMachineSnapshots !== 0) fail("machine ROI mapping not idempotent");
  console.log(`aktarım ✓ ${m1.perMachineSnapshots} makine snapshot + toplam P&L (inceleme çözülünce), tekrar=0`);

  // 4) purchase costs set on seeded machines; 2025 aggregate net matches source K4
  const roi = await loadMachineRoi(pool);
  const awea = roi.find((x) => x.name.toLowerCase() === "awea");
  const aweaPurchaseCost = awea?.purchase_cost ?? null;
  if (aweaPurchaseCost == null || !approx(aweaPurchaseCost, 78000, 1)) fail(`awea purchase cost wrong: ${aweaPurchaseCost}`);
  if (!roi.every((x) => x.confidence == null || x.confidence === "needs_review")) fail("ROI confidence must be needs_review");
  const agg = await loadMachineRoiAggregate(pool);
  const aggregateNet = agg?.net ?? null;
  const aggregateConfidence = agg?.confidence ?? null;
  if (aggregateNet == null || !approx(aggregateNet, 1405175.75, 1)) fail(`aggregate net ${aggregateNet} ≠ 1.405.175,75`);
  if (aggregateConfidence !== "needs_review") fail("aggregate ROI must be needs_review");
  console.log(`ROI ✓ awea alım=${aweaPurchaseCost}, 2025 net=${aggregateNet} (needs_review, kaynak K4 birebir)`);

  // 5) PRIVACY: no personal token ever reached a domain table (notes/name/label)
  const leakN = (await q(`
    select count(*)::int n from (
      select coalesce(notes,'') s from public.machine_roi_snapshots
      union all select name from public.machine_assets
      union all select coalesce(part_name,'') from public.production_parts
    ) t where lower(t.s) ~ '(tiyatro|harçlık|esma|hoppala|demircili)'`))[0].n;
  if (leakN > 0) fail("personal token leaked into a domain table");
  console.log("gizlilik ✓ (kişisel/aile gideri hiçbir domain tablosuna girmedi)");

  // 6) FINANCIAL INTEGRITY
  const after = await financeFingerprint();
  if (before !== after) fail("machine ROI mapping mutated a finance table — forbidden");
  console.log("mali bütünlük ✓ (makine ROI payments/cashflow/checks/loans/cost'u değiştirmedi)");

  console.log("PHASE9C VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
