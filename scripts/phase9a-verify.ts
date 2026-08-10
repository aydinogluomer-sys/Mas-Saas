// Phase 9A verification on REAL data (TEMİZ). Proves the cost-detail surfacing:
//   Akon TL/dk (K2/K4) mapped source-exact; fixed-cost breakdown lines captured &
//   source-traceable; idempotent re-map; margin (Akon − break-even) matches the pure
//   rule and flags the real loss (normal torna); FINANCIAL INTEGRITY: no finance/cashflow
//   table mutated (production-only writes, before==after fingerprint).
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import { loadCostBreakdown, loadCostModels, mapCapacitySheet, mapCostSheets } from "../src/lib/production/engine";
import { priceMargin } from "../src/lib/production/rules";
import { ensureSystemActor } from "./db/seed-system-actor";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
});
const fail = (m: string): never => { console.error("PHASE9A VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const SRC = process.env.PHASE9A_SRC ?? "data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx";
const approx = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

async function financeFingerprint(): Promise<string> {
  const rows = await q(`
    select 'payments' t, count(*) c, coalesce(sum(default_amount),0) s from public.payments
    union all select 'instances', count(*), coalesce(sum(amount),0) from public.payment_instances
    union all select 'cashflow', count(*), coalesce(sum(closing_balance),0) from public.cashflow_months
    union all select 'checks', count(*), coalesce(sum(signed_amount),0) from public.checks
    union all select 'loans', count(*), coalesce(sum(total_payment),0) from public.loans
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
  await pool.query(`truncate public.source_workbooks, public.capacity_models, public.cost_models, public.cost_breakdown_lines, public.production_parts, public.part_profitability_runs, public.payments, public.payment_instances, public.cashflow_months, public.checks, public.loans restart identity cascade`);
  const r = await importWorkbook(pool, readFileSync(SRC), "TEMİZ.xlsx", actorId);
  if (!r.ok) fail("import failed");
  const wb = r.workbookId;
  await pool.query(`update public.mapping_reviews set status='resolved'
    where issue_type in ('stale_rate','missing_operation_time','capacity_minutes_reconciliation',
                         'break_even_reconciliation','capacity_rate_missing','cost_model_missing')`);

  const before = await financeFingerprint();
  await mapCapacitySheet(pool, wb, actorId);
  const c1 = await mapCostSheets(pool, wb, actorId);
  if (c1.created !== 2) fail(`expected 2 cost models, got ${c1.created}`);
  const c2 = await mapCostSheets(pool, wb, actorId);
  if (c2.created !== 0) fail("cost mapping not idempotent");

  // 1) Akon rates mapped source-exact (K2 freze 27.5, K4 torna 21.88)
  const costs = await loadCostModels(pool);
  const normal = costs.find((x) => x.scenario === "normal")!;
  const srcRate = async (addr: string) => Number((await q(`select normalized_value v from public.source_cells sc
    join public.source_sheets ss on ss.id=sc.sheet_id
    where ss.detected_type='cost_model_normal' and sc.address=$1`, [addr]))[0].v);
  const srcK2 = await srcRate("K2"), srcK4 = await srcRate("K4");
  if (normal.akonFreze == null || !approx(normal.akonFreze, srcK2, 0.001)) fail(`akon freze ${normal.akonFreze} ≠ source K2 ${srcK2}`);
  if (normal.akonTorna == null || !approx(normal.akonTorna, srcK4, 0.001)) fail(`akon torna ${normal.akonTorna} ≠ source K4 ${srcK4}`);
  if (!approx(srcK2, 27.5, 0.01)) fail(`source K2 unexpected ${srcK2}`);
  console.log(`akon oranları ✓ freze=${normal.akonFreze} torna=${normal.akonTorna} (kaynak K2/K4 birebir)`);

  // 2) breakdown lines captured + source-traceable + idempotent
  const bd = await loadCostBreakdown(pool, normal.id);
  if (bd.length < 15) fail(`expected the fixed-cost ledger, got ${bd.length} lines`);
  const eleman = bd.find((b) => b.label === "eleman");
  if (!eleman || !approx(eleman.amount!, 357442, 1)) fail(`eleman line wrong: ${JSON.stringify(eleman)}`);
  const traced = (await q(`select count(*)::int n from public.cost_breakdown_lines where source_row_id is not null`))[0].n;
  const total = (await q(`select count(*)::int n from public.cost_breakdown_lines`))[0].n;
  if (traced !== total) fail("some breakdown lines lack source trace");
  console.log(`gider dökümü ✓ ${bd.length} kalem (normal), kaynak-izli %100 (ör. eleman=${eleman!.amount})`);

  // 3) margin: Akon price − break-even matches the pure rule exactly (per scenario's own
  //    Akon rate); the real normal-torna loss is flagged (21.88 < 26.18 break-even).
  const mNormalTorna = priceMargin(normal.breakEven, normal.akonTorna);
  const ntMargin = mNormalTorna.margin;
  if (ntMargin == null || !approx(ntMargin, normal.akonTorna! - normal.breakEven!, 0.001))
    return fail("margin ≠ price − break-even");
  if (!mNormalTorna.loss) fail("normal torna should be a LOSS (21.88 < 26.18 break-even)");
  if (priceMargin(normal.breakEven, normal.akonFreze).loss) fail("normal freze should NOT be a loss (27.5 > 26.18)");
  console.log(`marj ✓ math=fiyat−başabaş; normal torna ZARAR (${ntMargin.toFixed(2)}/dk), normal freze pozitif`);

  // 4) FINANCIAL INTEGRITY — no finance/cashflow table mutated by cost mapping
  const after = await financeFingerprint();
  if (before !== after) fail("cost mapping mutated a finance table — forbidden");
  console.log("mali bütünlük ✓ (maliyet detayı payments/cashflow/checks/loans'u değiştirmedi)");

  console.log("PHASE9A VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
