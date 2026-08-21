// Phase 2 verification: import the REAL workbooks into the dev DB and prove
// (a) raw preservation with zero silent discard, (b) failed-workbook path,
// (c) known anomalies land in mapping_reviews.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import { ensureSystemActor } from "./db/seed-system-actor";
import { ownerDatabaseUrl } from "./db/owner-url";

// Owner connection, not the runtime one. This script TRUNCATEs the staging tables before
// re-importing, and TRUNCATE is deliberately NOT granted to the application role: the app
// never issues it (only these operator scripts do), and handing it over would let a single
// compromised query destroy financial tables — without the row triggers that make
// audit_logs append-only ever firing. The hardcoded superuser fallback that used to live
// here is gone for the same reason src/lib/db.ts lost its own: a missing env var must not
// silently reconnect an operator tool to mas_radar_dev.
const connectionString = ownerDatabaseUrl();
if (!connectionString) {
  console.error("MIGRATION_DATABASE_URL (veya DATABASE_URL) tanımlı değil.");
  process.exit(1);
}
const pool = new Pool({ connectionString });

function fail(msg: string): never {
  console.error("VERIFY FAIL:", msg);
  process.exit(1);
}

async function main() {
  const actorId = await ensureSystemActor(pool);
  await pool.query("truncate public.source_workbooks cascade"); // staging only, dev db

  // 1) valid TEMİZ workbook
  const validPath = "data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx";
  const r1 = await importWorkbook(pool, readFileSync(validPath), "TEMİZ.xlsx", actorId);
  console.log("valid import:", JSON.stringify(r1));
  if (!r1.ok) fail("valid workbook import failed");
  if (r1.sheets !== 43) fail(`expected 43 sheets, got ${r1.sheets}`);
  if (r1.cellsInserted !== r1.cellsIterated)
    fail(`silent discard: iterated ${r1.cellsIterated} != inserted ${r1.cellsInserted}`);
  if (r1.reviewsInserted === 0) fail("expected known anomalies to produce reviews");

  // 2) corrupt workbook → failed status, no partial rows
  const corruptPath = "data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ-4.xlsx";
  const r2 = await importWorkbook(pool, readFileSync(corruptPath), "TEMİZ-4.xlsx", actorId);
  console.log("corrupt import:", JSON.stringify(r2));
  if (r2.ok) fail("corrupt workbook must fail");
  const partial = await pool.query(
    `select count(*)::int as n from public.source_cells where workbook_id=$1`,
    [r2.workbookId],
  );
  if (partial.rows[0].n !== 0) fail("corrupt workbook wrote partial cells");
  const st = await pool.query(
    `select status, parse_error from public.source_workbooks where id=$1`,
    [r2.workbookId],
  );
  if (st.rows[0].status !== "failed" || !/signature/.test(st.rows[0].parse_error))
    fail("failed status/parse_error not recorded");

  // 3) known-anomaly spot checks (docs/data-map.md anomaly register)
  const spot = async (q: string, name: string) => {
    const r = await pool.query(q);
    if (r.rows[0].n === 0) fail(`missing expected review: ${name}`);
    console.log(`spot ✓ ${name}: ${r.rows[0].n}`);
  };
  await spot(
    `select count(*)::int as n from public.mapping_reviews where issue_type='negative_amount' and message like '%-60000%'`,
    "TİJEN −60.000 negative_amount",
  );
  await spot(
    `select count(*)::int as n from public.mapping_reviews where issue_type='unlabeled_amount' and message like '%120000%'`,
    "AG25 unlabeled_amount 120000",
  );
  await spot(
    `select count(*)::int as n from public.mapping_reviews where issue_type='missing_due_day' and message like '%PRONET%'`,
    "PRONET missing_due_day",
  );
  await spot(
    `select count(*)::int as n from public.mapping_reviews where issue_type='duplicate_check'`,
    "ÇEKLER duplicate suspicion",
  );

  // 4) DB-level no-discard cross-check + needs_review wiring
  const agg = await pool.query(`
    select
      (select count(*)::int from public.source_sheets   where workbook_id=$1) as sheets,
      (select count(*)::int from public.source_cells    where workbook_id=$1) as cells,
      (select count(*)::int from public.import_rows     where workbook_id=$1) as rows,
      (select count(*)::int from public.import_rows     where workbook_id=$1 and mapping_status='needs_review') as needs_review,
      (select count(*)::int from public.mapping_reviews where workbook_id=$1) as reviews
  `, [r1.workbookId]);
  console.log("db totals:", JSON.stringify(agg.rows[0]));
  if (agg.rows[0].cells !== r1.cellsInserted) fail("db cell count mismatch");
  if (agg.rows[0].needs_review === 0) fail("needs_review rows not marked");

  // identity check across monthly sheets: TEMİZ chain repaired → expect zero mismatches
  const idm = await pool.query(
    `select count(*)::int as n from public.mapping_reviews where issue_type='cashflow_identity_mismatch'`,
  );
  console.log("cashflow identity mismatches:", idm.rows[0].n, "(TEMİZ beklenen: 0)");

  console.log("PHASE2 IMPORT VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
