// Dev/demo state builder: full pipeline on the real workbook so every
// dashboard is populated (used by the E2E smoke; safe to re-run).
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import { ensureWindow, mapAcceptedCandidates } from "../src/lib/radar/engine";
import { mapCashflowMonths, validateContinuity, writeSnapshots } from "../src/lib/cashflow/engine";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
});

async function main() {
  await pool.query(
    "truncate public.source_workbooks, public.payments, public.payment_instances, public.cashflow_months, public.cashflow_snapshots, public.audit_logs restart identity cascade",
  );
  const r = await importWorkbook(
    pool,
    readFileSync("data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx"),
    "TEMİZ.xlsx",
  );
  if (!r.ok) throw new Error("import failed: " + r.error);

  // same controlled review decisions as phase3-verify (documented semantics)
  const dec = (like: string, status: string) =>
    pool.query(
      `update public.mapping_reviews set status=$2, reviewed_at=now()
       where workbook_id=$1 and message like $3`,
      [r.workbookId, status, like],
    );
  await dec("%ÖMER%", "accepted");
  await dec("%ATİLLA%", "rejected");
  await dec("%PRONET%", "accepted");
  await pool.query(
    `update public.mapping_reviews set status='accepted', reviewed_at=now()
     where workbook_id=$1 and issue_type='multiple_day_markers'`,
    [r.workbookId],
  );

  const today = new Date().toISOString().slice(0, 10);
  const pm = await mapAcceptedCandidates(pool, r.workbookId);
  await ensureWindow(pool, today);
  const cf = await mapCashflowMonths(pool, r.workbookId);
  const cont = await validateContinuity(pool);
  await writeSnapshots(pool, today);
  console.log(
    `SEED OK — payments=${pm.created} · cashflow months=${cf.monthsCreated} lines=${cf.linesCreated} · chain breaks=${cont.breaks}`,
  );
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
